/**
 * Per-request pipeline: pick an Antigravity account, refresh its token when
 * stale, and rewrite the outbound request the way the V1 auth `fetch` did.
 *
 * The V1 plugin owned a whole fetch implementation with account rotation,
 * retries and quota gating. V2 has no fetch takeover, so the same flow is
 * driven from the native request hooks: this module produces the prepared
 * request and the metadata the response hook needs, and the retry policy is
 * applied through the `retry` hook.
 */
import {
	cliFingerprint,
	rewriteModelAliasInUrl,
	tierVersionedFlashBody,
} from "./identity.js";
import {
	ANTIGRAVITY_ENDPOINT_FALLBACKS,
	type AntigravityConfig,
	accessTokenExpired,
	extractModelFromUrl,
	GEMINI_CLI_ENDPOINT,
	isGenerativeLanguageRequest,
	type ManagedAccount,
	type OAuthAuthDetails,
	type ProjectContextResult,
	type prepareAntigravityRequest,
	resolveHeaderRoutingDecision,
} from "./upstream.js";

export type HeaderStyle = "antigravity" | "gemini-cli";

/** Account pool surface used here; satisfied by the upstream AccountManager. */
export type ManagerLike = {
	getAccountCount(): number;
	getCurrentOrNextForFamily(
		family: "claude" | "gemini",
		model: string | null | undefined,
		strategy: string,
		headerStyle: HeaderStyle,
		pidOffsetEnabled: boolean,
		softQuotaThresholdPercent: number,
		softQuotaCacheTtlMs: number,
	): ManagedAccount | null;
	areAllAccountsOverSoftQuota(
		family: "claude" | "gemini",
		threshold: number,
		cacheTtlMs: number,
		model: string | null | undefined,
	): boolean;
	getMinWaitTimeForSoftQuota(
		family: "claude" | "gemini",
		threshold: number,
		cacheTtlMs: number,
		model: string | null | undefined,
	): number | null;
	getMinWaitTimeForFamily(
		family: "claude" | "gemini",
		model: string | null | undefined,
		headerStyle: HeaderStyle,
		strictWait: boolean,
	): number | null;
	markAccountCoolingDown(
		account: ManagedAccount,
		cooldownMs: number,
		reason: string,
	): void;
	markRateLimited(
		account: ManagedAccount,
		retryAfterMs: number,
		family: "claude" | "gemini",
		headerStyle?: HeaderStyle,
		model?: string | null,
	): void;
	toAuthDetails(account: ManagedAccount): OAuthAuthDetails;
	updateFromAuth(account: ManagedAccount, auth: OAuthAuthDetails): void;
	saveToDisk(): Promise<void>;
};

export type LogLevel = "debug" | "info" | "warn" | "error";

export type PipelineDeps = {
	log: (
		level: LogLevel,
		message: string,
		extra?: Record<string, unknown>,
	) => void;
	readAuth: (providerID: string) => Promise<OAuthAuthDetails | undefined>;
	/** Loads the account pool; the credential seeds it when the pool is empty. */
	loadManager: (auth: OAuthAuthDetails | undefined) => Promise<ManagerLike>;
	refresh: (auth: OAuthAuthDetails) => Promise<OAuthAuthDetails | undefined>;
	/**
	 * Resolves the Cloud project the account is entitled to. The upstream fetch
	 * does this before every request; leaving it out sends a synthetic project
	 * id that no subscription is attached to.
	 */
	projectContext: (auth: OAuthAuthDetails) => Promise<ProjectContextResult>;
	prepare: typeof prepareAntigravityRequest;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
};

export type PipelineSettings = {
	providerID: string;
	accountSelectionStrategy: string;
	softQuotaThresholdPercent: number;
	softQuotaCacheTtlMs: number;
	pidOffsetEnabled: boolean;
	maxWaitMs: number;
	cliFirst: boolean;
};

/** Settings derived from the plugin options merged over the upstream config. */
export function settingsFrom(
	options: Partial<AntigravityConfig> & Record<string, unknown>,
): PipelineSettings {
	return {
		providerID:
			typeof options.provider_id === "string" ? options.provider_id : "google",
		accountSelectionStrategy: options.account_selection_strategy ?? "sticky",
		softQuotaThresholdPercent: options.soft_quota_threshold_percent ?? 100,
		softQuotaCacheTtlMs: options.soft_quota_cache_ttl_minutes
			? Number(options.soft_quota_cache_ttl_minutes) * 60_000
			: 10 * 60_000,
		pidOffsetEnabled: Boolean(options.pid_offset_enabled),
		maxWaitMs: (options.max_rate_limit_wait_seconds ?? 300) * 1000,
		cliFirst: Boolean(options.cli_first),
	};
}

/** Everything the response hook needs to transform a response and book quota. */
export type ManagedRequestMeta = {
	manager: ManagerLike;
	account: ManagedAccount;
	family: "claude" | "gemini";
	model: string | null;
	headerStyle: HeaderStyle;
	endpoint: string;
	endpointIndex: number;
	streaming: boolean;
	requestedModel?: string;
	projectId?: string;
	effectiveModel?: string;
	sessionId?: string;
	toolDebugMissing?: number;
	toolDebugSummary?: string;
	toolDebugPayload?: string;
};

export type PipelineResult = { request: Request; meta: ManagedRequestMeta };

/** Endpoint a request spends quota on: CLI quota is production-only. */
export function endpointFor(
	headerStyle: HeaderStyle,
	endpointIndex: number,
): string {
	if (headerStyle === "gemini-cli") return GEMINI_CLI_ENDPOINT;
	return ANTIGRAVITY_ENDPOINT_FALLBACKS[endpointIndex] ?? GEMINI_CLI_ENDPOINT;
}

/**
 * Builds the outbound request for one Generative Language API call.
 *
 * Returns undefined when the request is not managed here: not a Generative
 * Language URL, or opencode holds a non-OAuth credential such as an API key
 * (the request then falls through to opencode's own auth). Without any
 * credential the account pool alone is used, and an empty pool is an error
 * that says how to sign in.
 */
export async function buildManagedRequest(
	original: Request,
	deps: PipelineDeps,
	settings: PipelineSettings,
	endpointIndex = 0,
): Promise<PipelineResult | undefined> {
	// The backend serves Gemini 4 Argon only under its tiered id, so the model
	// is rewritten before anything else reads it: routing, quota keys and the
	// prepared request must all agree on the id that actually goes on the wire.
	const urlString = rewriteModelAliasInUrl(original.url);
	if (!isGenerativeLanguageRequest(urlString)) return undefined;
	const auth = await deps.readAuth(settings.providerID);
	if (auth && auth.type !== "oauth") return undefined;
	const seed = auth?.refresh ? auth : undefined;

	const family =
		urlString.includes("/claude") ||
		extractModelFromUrl(urlString)?.includes("claude")
			? ("claude" as const)
			: ("gemini" as const);
	const model = extractModelFromUrl(urlString);
	const routing = resolveHeaderRoutingDecision(urlString, family, {
		cli_first: settings.cliFirst,
	});

	const manager = await deps.loadManager(seed);
	if (manager.getAccountCount() === 0) {
		throw new Error(
			"No Antigravity accounts configured. Run `opencode auth login` and choose OAuth with Google (Antigravity).",
		);
	}

	const deadline = deps.now() + settings.maxWaitMs;
	let account: ManagedAccount | null | undefined;
	let headerStyle: HeaderStyle = routing.preferredHeaderStyle;
	const alternateStyle: HeaderStyle =
		routing.preferredHeaderStyle === "antigravity"
			? "gemini-cli"
			: "antigravity";

	// Bounded selection loop: a refresh failure cools that account down and tries
	// the next one; an empty pool waits out cooldowns until the deadline.
	for (let attempt = 0; attempt < 4 && !account; attempt++) {
		account = manager.getCurrentOrNextForFamily(
			family,
			model,
			settings.accountSelectionStrategy,
			headerStyle,
			settings.pidOffsetEnabled,
			settings.softQuotaThresholdPercent,
			settings.softQuotaCacheTtlMs,
		);
		if (!account && routing.allowQuotaFallback) {
			account = manager.getCurrentOrNextForFamily(
				family,
				model,
				settings.accountSelectionStrategy,
				alternateStyle,
				settings.pidOffsetEnabled,
				settings.softQuotaThresholdPercent,
				settings.softQuotaCacheTtlMs,
			);
			if (account) headerStyle = alternateStyle;
		}
		if (account) break;

		const waitMs = manager.areAllAccountsOverSoftQuota(
			family,
			settings.softQuotaThresholdPercent,
			settings.softQuotaCacheTtlMs,
			model,
		)
			? manager.getMinWaitTimeForSoftQuota(
					family,
					settings.softQuotaThresholdPercent,
					settings.softQuotaCacheTtlMs,
					model,
				)
			: manager.getMinWaitTimeForFamily(family, model, headerStyle, true);
		if (waitMs == null || waitMs <= 0 || deps.now() + waitMs > deadline) {
			throw new Error(
				`All ${manager.getAccountCount()} Antigravity account(s) are rate-limited or over quota for ${family}. ` +
					"Add accounts with `opencode auth login` or wait for quota reset.",
			);
		}
		deps.log(
			"warn",
			`all Antigravity accounts busy for ${family}; waiting ${Math.ceil(waitMs / 1000)}s`,
		);
		await deps.sleep(waitMs);
	}
	if (!account)
		throw new Error(`No Antigravity account became available for ${family}.`);

	let authRecord = manager.toAuthDetails(account);
	if (accessTokenExpired(authRecord)) {
		const refreshed = await deps.refresh(authRecord).catch(() => undefined);
		if (!refreshed) {
			manager.markAccountCoolingDown(account, 60_000, "auth-failure");
			manager.markRateLimited(account, 60_000, family, headerStyle, model);
			await manager.saveToDisk().catch(() => undefined);
			throw new Error(
				"Antigravity token refresh failed; the account is cooling down.",
			);
		}
		manager.updateFromAuth(account, refreshed);
		authRecord = refreshed;
		await manager.saveToDisk().catch(() => undefined);
	}

	// Resolving the project before the send keeps the request on the account's
	// real Cloud project instead of the synthetic one preparation invents when
	// it is given an empty id. A failure here is not fatal: the fallback project
	// the resolver returns is still serviceable, so the turn goes ahead.
	let projectId = "";
	try {
		const project = await deps.projectContext(authRecord);
		projectId = project.effectiveProjectId;
		if (
			project.auth.refresh !== authRecord.refresh ||
			project.auth.access !== authRecord.access
		) {
			manager.updateFromAuth(account, project.auth);
			authRecord = project.auth;
			await manager.saveToDisk().catch(() => undefined);
		}
	} catch (error) {
		deps.log(
			"warn",
			`project context unavailable; falling back to the default project: ${String(error)}`,
		);
	}

	const body = await original.clone().text();
	// The native provider always sends its own credential headers (an empty
	// `x-goog-api-key` when it has no key). Request preparation adds the
	// account's header for the chosen quota style but keeps unrelated ones, and
	// a stale or empty API key outranks the bearer token at Google's edge.
	const headers = new Headers(original.headers);
	for (const name of [...headers.keys()]) {
		if (
			name.toLowerCase() === "x-goog-api-key" ||
			name.toLowerCase() === "authorization"
		)
			headers.delete(name);
	}
	const init: RequestInit = {
		method: original.method,
		headers,
		body: body.length > 0 ? body : undefined,
	};
	const endpoint = endpointFor(headerStyle, endpointIndex);
	const prepared = deps.prepare(
		urlString,
		init,
		authRecord.access ?? "",
		projectId,
		endpoint,
		headerStyle,
		false,
		{
			// Request preparation turns this fingerprint into the outgoing
			// User-Agent, which is what decides whether Gemini 4 Argon is served.
			fingerprint: cliFingerprint(
				(account as { fingerprint?: { userAgent?: string } }).fingerprint,
			),
		},
	);

	// `gemini-3.8-flash` and its siblings need a tiered id that preparation
	// strips; it is restored from the thinking level preparation settled on.
	const tiered = tierVersionedFlashBody(prepared.init?.body);
	const request = new Request(prepared.request as RequestInfo, {
		...(prepared.init as RequestInit),
		...(tiered ? { body: tiered.body } : {}),
	});
	return {
		request,
		meta: {
			manager,
			account,
			family,
			model,
			headerStyle,
			endpoint,
			endpointIndex,
			streaming: Boolean(prepared.streaming),
			requestedModel: prepared.requestedModel,
			projectId: prepared.projectId,
			effectiveModel: tiered?.model ?? prepared.effectiveModel,
			sessionId: prepared.sessionId,
			toolDebugMissing: prepared.toolDebugMissing,
			toolDebugSummary: prepared.toolDebugSummary,
			toolDebugPayload: prepared.toolDebugPayload,
		},
	};
}
