/**
 * OpenCode V2 adapter for the `opencode-antigravity-auth` account machinery.
 *
 * The upstream package is a V1 plugin: it supplies credentials through V1's
 * `auth` hook via a custom `fetch` that owns account rotation, quota gating
 * and request rewriting. V2 has neither that hook nor a fetch takeover (its
 * native provider does not use the global fetch), so the same behaviour is
 * rebuilt on the native request hooks:
 *
 * | upstream V1 fetch                    | this adapter                         |
 * | ------------------------------------ | ------------------------------------ |
 * | pick account, wait out cooldowns     | `http.request` (before the send)     |
 * | refresh expired access tokens        | `http.request`                       |
 * | rewrite URL/headers/body per quota   | `http.request` (request replacement) |
 * | transform the streamed response      | `http.response` (response swap)      |
 * | retry with the next account/endpoint | `retry` hook                         |
 *
 * Everything heavy (account pool, tokens, request preparation, response
 * transformation) is reused from the upstream package by module path. On V1
 * the default export's `server` entry runs the upstream plugin as is.
 */
import { define, type Plugin } from "@opencode/plugin/promise/plugin";
import { GoogleOAuthPlugin } from "opencode-antigravity-auth";
import { readProviderAuth, writeProviderAuth } from "./auth-store.js";
import {
	migrateFingerprintsToCliUserAgent,
	rewriteRequestModel,
} from "./identity.js";
import {
	buildManagedRequest,
	type LogLevel,
	type ManagedRequestMeta,
	type PipelineDeps,
	type PipelineSettings,
	settingsFrom,
} from "./pipeline.js";
import {
	AccountManager,
	ensureProjectContext,
	getStoragePath,
	isGenerativeLanguageRequest,
	type OAuthAuthDetails,
	prepareAntigravityRequest,
	refreshAccessToken,
	transformAntigravityResponse,
} from "./upstream.js";

const RETRYABLE_STATUSES = new Set([429, 503, 529]);
const MAX_ADAPTER_RETRIES = 3;
const DEFAULT_RETRY_AFTER_MS = 60_000;

/** Retry-after header, in milliseconds, with the V1 fetch's default. */
export function retryAfterMs(
	response: Response,
	fallback = DEFAULT_RETRY_AFTER_MS,
): number {
	const header = response.headers.get("retry-after");
	const seconds = header ? Number(header) : Number.NaN;
	return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : fallback;
}

type RetryState = { attempts: number; delayMs: number; endpointIndex: number };

export type AntigravityV2Options = Record<string, unknown>;

/** Builds the plugin definition, optionally with test doubles. */
export function createAntigravityAuthV2(
	overrides: Partial<PipelineDeps> & {
		transform?: typeof transformAntigravityResponse;
	} = {},
): Plugin {
	return define({
		id: "antigravity-auth",
		setup: (ctx) => {
			const options = ctx.options as AntigravityV2Options;
			const settings: PipelineSettings = settingsFrom(options);
			const log = (
				level: LogLevel,
				message: string,
				extra?: Record<string, unknown>,
			) => {
				const suffix = extra === undefined ? "" : ` ${JSON.stringify(extra)}`;
				const line = `[antigravity-auth] ${message}${suffix}`;
				if (level === "error") console.error(line);
				else if (level === "warn") console.warn(line);
				else console.log(line);
			};

			// The upstream token refresher persists through the V1 client; this shim
			// writes the same credential store file the adapter reads.
			const client = {
				app: { log: async () => undefined },
				tui: { showToast: async () => undefined },
				auth: {
					set: async (input: {
						path: { id: string };
						body: OAuthAuthDetails;
					}) => {
						writeProviderAuth(input.path.id, input.body);
					},
				},
			};

			const deps: PipelineDeps = {
				log,
				readAuth: async (providerID) =>
					readProviderAuth(providerID) as OAuthAuthDetails | undefined,
				loadManager: async (auth) => AccountManager.loadFromDisk(auth),
				refresh: (auth) =>
					refreshAccessToken(auth, client, settings.providerID),
				projectContext: (auth) => ensureProjectContext(auth),
				prepare: prepareAntigravityRequest,
				now: Date.now,
				sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
				...overrides,
			};

			const metaByRequest = new WeakMap<Request, ManagedRequestMeta>();
			const metaBySession = new Map<string, ManagedRequestMeta>();
			const retryBySession = new Map<string, RetryState>();

			void ctx.session.hook("http.request", async (event) => {
				if (event.model.providerID !== settings.providerID) return;
				if (!isGenerativeLanguageRequest(event.request.url)) return;
				const endpointIndex =
					retryBySession.get(String(event.sessionID))?.endpointIndex ?? 0;
				const built = await buildManagedRequest(
					event.request,
					deps,
					settings,
					endpointIndex,
				);
				if (!built) return;
				metaByRequest.set(built.request, built.meta);
				metaBySession.set(String(event.sessionID), built.meta);
				event.request = built.request;
			});

			void ctx.session.hook("http.response", async (event) => {
				const sessionID = String(event.sessionID);
				const meta =
					metaByRequest.get(event.request) ?? metaBySession.get(sessionID);
				if (!meta) return;

				const status = event.response.status;
				if (RETRYABLE_STATUSES.has(status)) {
					meta.manager.markRateLimited(
						meta.account,
						retryAfterMs(event.response),
						meta.family,
						meta.headerStyle,
						meta.model,
					);
					await meta.manager.saveToDisk().catch(() => undefined);
					const previous = retryBySession.get(sessionID);
					retryBySession.set(sessionID, {
						attempts: previous?.attempts ?? 0,
						delayMs: retryAfterMs(event.response),
						// Capacity errors move the antigravity endpoint forward; rate
						// limits stay put and rotate the account instead.
						endpointIndex:
							status === 429 ? meta.endpointIndex : meta.endpointIndex + 1,
					});
				} else if (status >= 200 && status < 300) {
					retryBySession.delete(sessionID);
				}

				event.response = await (
					overrides.transform ?? transformAntigravityResponse
				)(
					event.response,
					meta.streaming,
					undefined,
					meta.requestedModel,
					meta.projectId,
					meta.endpoint,
					meta.effectiveModel,
					meta.sessionId,
					meta.toolDebugMissing,
					meta.toolDebugSummary,
					meta.toolDebugPayload,
					undefined,
				);
			});

			void ctx.session.hook("retry", (event) => {
				const sessionID = String(event.sessionID);
				const state = retryBySession.get(sessionID);
				if (!state || state.attempts >= MAX_ADAPTER_RETRIES) return;
				state.attempts += 1;
				event.decision = { retry: true, delay: state.delayMs };
				log(
					"debug",
					`retrying via ${event.model.providerID} after ${state.delayMs}ms (attempt ${state.attempts})`,
				);
			});
		},
	});
}

/** The V2 plugin entrypoint. */
export const AntigravityAuthV2 = createAntigravityAuthV2();

/**
 * Rewrites the model id in the requests opencode sends to the upstream fetch.
 *
 * The upstream plugin reads the model out of the URL and never aliases it, so
 * an id like `gemini-4-argon` reaches the backend and comes back 404. Aliasing
 * here keeps every downstream step — routing, quota keys, the prepared body —
 * on the id the backend actually serves.
 */
function withModelAlias(
	inner: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
	return (input, init) => inner(rewriteRequestModel(input), init);
}

/**
 * Builds the V1 entrypoint: the upstream plugin with two adapter-level fixes.
 *
 * V1 still has the `auth` hook and fetch takeover that the V2 adapter rebuilds,
 * so nothing is ported. What the upstream cannot do for itself is done around
 * it: stored account fingerprints are moved onto the CLI User-Agent (the
 * backend only serves Gemini 4 Argon to that identity), and the models opencode
 * advertises under ids the backend does not serve are aliased before they reach
 * the upstream fetch.
 *
 * Upstream reads its settings from `antigravity.json`, not from the plugin
 * options, so options given here are reported in the log rather than applied.
 *
 * `resolveAccountsPath` names the account pool to migrate and is required: that
 * file is live user state, so it must be named rather than defaulted, which
 * keeps tests from ever writing to a real pool by accident.
 */
export function createAntigravityAuthV1(
	upstream = GoogleOAuthPlugin,
	resolveAccountsPath: () => string,
) {
	return async (
		input: Parameters<typeof GoogleOAuthPlugin>[0],
		options?: AntigravityV2Options,
	) => {
		// Migrated before the upstream loads the pool, so the identity it reads
		// from disk is already the one the backend accepts.
		await migrateFingerprintsToCliUserAgent(resolveAccountsPath()).catch(
			() => 0,
		);
		if (options && Object.keys(options).length > 0) {
			await Promise.resolve(
				input.client.app.log({
					body: {
						service: "antigravity-auth",
						level: "warn",
						message:
							"plugin options are ignored on opencode V1; set them in antigravity.json",
						extra: { options: Object.keys(options) },
					},
				}),
			).catch(() => undefined);
		}
		const result = await upstream(input);
		const loader = result?.auth?.loader;
		if (typeof loader !== "function") return result;
		result.auth.loader = (async (
			getAuth: Parameters<typeof loader>[0],
			provider: Parameters<typeof loader>[1],
		) => {
			const loaded = await loader(getAuth, provider);
			if (loaded && typeof loaded === "object" && "fetch" in loaded) {
				const fetchable = loaded as {
					fetch: (
						input: RequestInfo | URL,
						init?: RequestInit,
					) => Promise<Response>;
				};
				if (typeof fetchable.fetch === "function") {
					fetchable.fetch = withModelAlias(fetchable.fetch.bind(fetchable));
				}
			}
			return loaded;
		}) as typeof loader;
		return result;
	};
}

/** The V1 plugin entrypoint. */
export const AntigravityAuthV1 = createAntigravityAuthV1(
	GoogleOAuthPlugin,
	getStoragePath,
);

/** One module for both generations: V2 reads `id`/`setup`, V1 reads `server`. */
const AntigravityAuthModule = {
	...AntigravityAuthV2,
	server: AntigravityAuthV1,
};

export default AntigravityAuthModule;
