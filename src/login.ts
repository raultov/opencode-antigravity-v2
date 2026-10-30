/**
 * The V2 login flow: an OAuth method on the provider's integration.
 *
 * The V1 plugin offered "OAuth with Google (Antigravity)" through its `auth`
 * hook, which V2 removed. V2 asks plugins to register sign-in methods on an
 * integration instead, so the same flow is registered there: the upstream
 * authorization URL and token exchange are reused, the account joins the
 * shared account pool like a V1 `/connect` login, and V2 stores the returned
 * credential as the provider's connection.
 */
import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/promise/integration";
import {
	type AccountStorageV4,
	type AntigravityTokenExchangeResult,
	type authorizeAntigravity,
	type OAuthAuthDetails,
	type OAuthListener,
	parseRefreshParts,
} from "./upstream.js";

type OAuthCredential = Awaited<
	ReturnType<NonNullable<IntegrationOAuthMethodRegistration["refresh"]>>
>;
type ExchangeSuccess = Extract<
	AntigravityTokenExchangeResult,
	{ type: "success" }
>;

/** Method id V2 records on the credential this flow creates. */
export const LOGIN_METHOD_ID = "antigravity";

/** How long the local listener waits for Google's redirect, as upstream. */
const LISTENER_TIMEOUT_MS = 5 * 60 * 1000;

export type LoginDeps = {
	authorize: typeof authorizeAntigravity;
	exchange: (
		code: string,
		state: string,
	) => Promise<AntigravityTokenExchangeResult>;
	startListener: () => Promise<OAuthListener>;
	addAccount: (result: ExchangeSuccess) => Promise<void>;
	refresh: (auth: OAuthAuthDetails) => Promise<OAuthAuthDetails | undefined>;
	/** True when the browser cannot reach a listener on this machine. */
	remote: () => boolean;
	now: () => number;
};

/**
 * True when the sign-in browser runs on another machine, so Google's redirect
 * to localhost never reaches this process and the code has to be pasted.
 *
 * Unlike the upstream check, a missing `DISPLAY` does not count: the V2 server
 * may run as a background service without one while the browser is local.
 */
export function isRemoteSession(env = process.env): boolean {
	return Boolean(
		env.SSH_CONNECTION ||
			env.SSH_CLIENT ||
			env.SSH_TTY ||
			env.OPENCODE_HEADLESS ||
			env.REMOTE_CONTAINERS ||
			env.CODESPACES,
	);
}

/** Code and state from a pasted redirect URL or a bare authorization code. */
export function parseCallbackInput(
	value: string,
	fallbackState: string,
): { code: string; state: string } {
	const trimmed = value.trim();
	if (!trimmed) throw new Error("Missing authorization code");
	if (URL.canParse(trimmed)) {
		const url = new URL(trimmed);
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state") ?? fallbackState;
		if (!code) throw new Error("Missing code in callback URL");
		if (!state) throw new Error("Missing state in callback URL");
		return { code, state };
	}
	if (!fallbackState) {
		throw new Error(
			"Missing state. Paste the full redirect URL instead of only the code.",
		);
	}
	return { code: trimmed, state: fallbackState };
}

export type PoolStore = {
	load: () => Promise<AccountStorageV4 | null>;
	save: (storage: AccountStorageV4) => Promise<void>;
};

/**
 * Adds a signed-in account to the pool, or refreshes the stored entry for the
 * same email or refresh token, as the upstream `/connect` login does.
 */
export async function addAccountToPool(
	result: ExchangeSuccess,
	store: PoolStore,
	now = Date.now(),
): Promise<void> {
	const parts = parseRefreshParts(result.refresh);
	if (!parts.refreshToken) return;
	const stored = await store.load();
	const accounts = [...(stored?.accounts ?? [])];
	const index = accounts.findIndex(
		(account) =>
			(result.email !== undefined && account.email === result.email) ||
			account.refreshToken === parts.refreshToken,
	);
	const existing = index >= 0 ? accounts[index] : undefined;
	const entry = {
		...existing,
		email: result.email ?? existing?.email,
		refreshToken: parts.refreshToken,
		projectId: parts.projectId ?? existing?.projectId,
		managedProjectId: parts.managedProjectId ?? existing?.managedProjectId,
		addedAt: existing?.addedAt ?? now,
		lastUsed: now,
		enabled: existing?.enabled ?? true,
	};
	if (index >= 0) accounts[index] = entry;
	else accounts.push(entry);

	const last = accounts.length - 1;
	const active = Math.min(Math.max(stored?.activeIndex ?? 0, 0), last);
	await store.save({
		version: 4,
		accounts,
		activeIndex: active,
		activeIndexByFamily: { claude: active, gemini: active },
	});
}

function toCredential(result: ExchangeSuccess): OAuthCredential {
	return {
		type: "oauth",
		methodID: LOGIN_METHOD_ID,
		refresh: result.refresh,
		access: result.access,
		expires: result.expires,
		metadata: result.email ? { email: result.email } : undefined,
	} as OAuthCredential;
}

/** The OAuth method registration for one integration. */
export function loginMethod(
	integrationID: string,
	deps: LoginDeps,
): IntegrationOAuthMethodRegistration {
	const finish = async (code: string, state: string) => {
		const result = await deps.exchange(code, state);
		if (result.type !== "success") throw new Error(result.error);
		await deps.addAccount(result);
		return toCredential(result);
	};

	return {
		integrationID,
		method: {
			id: LOGIN_METHOD_ID,
			type: "oauth",
			label: "OAuth with Google (Antigravity)",
		},
		label: (credential) =>
			typeof credential.metadata?.email === "string"
				? credential.metadata.email
				: undefined,
		refresh: async (credential) => {
			const refreshed = await deps.refresh({
				type: "oauth",
				refresh: credential.refresh,
				access: credential.access,
				expires: credential.expires,
			});
			if (!refreshed?.access) {
				throw new Error("Antigravity token refresh failed; log in again.");
			}
			return {
				...credential,
				refresh: refreshed.refresh,
				access: refreshed.access,
				expires: refreshed.expires ?? credential.expires,
			};
		},
		authorize: async () => {
			const listener = deps.remote()
				? undefined
				: await deps.startListener().catch(() => undefined);
			const authorization = await deps.authorize("");
			const state = new URL(authorization.url).searchParams.get("state") ?? "";

			if (listener) {
				const callback = (async () => {
					try {
						const url = await listener.waitForCallback();
						const code = url.searchParams.get("code");
						const returned = url.searchParams.get("state");
						if (!code || !returned) {
							throw new Error("Missing code or state in callback URL");
						}
						return await finish(code, returned);
					} finally {
						await listener.close().catch(() => undefined);
					}
				})();
				// A cancelled sign-in is never awaited; its timeout must not surface
				// as an unhandled rejection.
				callback.catch(() => undefined);
				return {
					mode: "auto",
					url: authorization.url,
					instructions:
						"Complete sign-in in your browser. The redirect back to localhost is detected automatically.",
					expiresAt: deps.now() + LISTENER_TIMEOUT_MS,
					callback,
				};
			}

			return {
				mode: "code",
				url: authorization.url,
				instructions:
					"Open the URL, complete sign-in, then paste the full redirect URL or the authorization code.",
				callback: async (input: string) => {
					const params = parseCallbackInput(input, state);
					return finish(params.code, params.state);
				},
			};
		},
	};
}
