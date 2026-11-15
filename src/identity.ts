/**
 * Client identity and model id compatibility with the Antigravity backend.
 *
 * The Code Assist backend keys part of its behaviour off the User-Agent: the
 * CLI identity (`antigravity/cli/...`) unlocks the models the Antigravity CLI
 * ships, while the IDE identity (`antigravity/<version> <os>/<arch>`) only gets
 * the older catalog. Gemini 4 Argon is the first model that makes the
 * difference visible: with the IDE identity the backend answers 404 for
 * `gemini-4-argon-*`, and with the CLI identity it streams normally.
 *
 * The second half of the problem is the model id: the CLI addresses Argon by
 * its tiered ids (`gemini-4-argon-low|medium|high`) and the bare
 * `gemini-4-argon` opencode lists is not a valid id at all. Versioned Gemini 3
 * flash models (`gemini-3.8-flash`) have the same requirement.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { getAntigravityVersion } from "opencode-antigravity-auth/dist/src/constants.js";

/**
 * Models opencode advertises under an id the Antigravity backend does not
 * serve. Keys are requested ids, values are the backend ids.
 */
const MODEL_ALIASES: Record<string, string> = {
	"gemini-4-argon": "gemini-4-argon-medium",
};

/**
 * Gemini 3 flash models with a minor version (`gemini-3.8-flash`). Unlike
 * `gemini-3-flash`, which the backend serves under its bare id plus a
 * `thinkingLevel`, these are only served under a tiered id; the bare one
 * answers 404.
 */
const VERSIONED_GEMINI_3_FLASH = /^gemini-3\.\d+-flash$/i;

/** A model id that pins its own thinking tier (`…-flash-high`). */
const FIXED_TIER = /-(?:minimal|low|medium|high)$/i;

/** Thinking levels the backend accepts. */
const THINKING_LEVELS = new Set(["minimal", "low", "medium", "high"]);

/** Tier suffixes the backend serves for versioned Gemini 3 flash models. */
const FLASH_TIERS = new Set(["low", "medium", "high"]);

/** Prefix the backend recognises as the Antigravity CLI client. */
const CLI_UA_PREFIX = "antigravity/cli/";

/**
 * Maps a requested model id onto the id the backend serves.
 *
 * Tiered ids (`gemini-4-argon-low|medium|high`) and every other model pass
 * through unchanged.
 */
export function resolveModelAlias(model: string): string {
	return MODEL_ALIASES[model] ?? model;
}

/**
 * Applies `resolveModelAlias` to the model id inside a Generative Language
 * request URL, leaving the rest of the URL untouched.
 */
export function rewriteModelAliasInUrl(urlString: string): string {
	return urlString.replace(
		/\/models\/([^:/?]+)/,
		(_match, model: string) => `/models/${resolveModelAlias(model)}`,
	);
}

/**
 * Maps a versioned Gemini 3 flash id onto the tiered id the backend serves,
 * picking the tier from the thinking level the request carries. Levels the
 * backend has no tier for (`minimal`, or none at all) fall back to `low`, the
 * upstream default for Gemini 3. Every other model passes through unchanged.
 */
export function tierVersionedFlashModel(
	model: string,
	thinkingLevel: unknown,
): string {
	if (!VERSIONED_GEMINI_3_FLASH.test(model)) return model;
	const level =
		typeof thinkingLevel === "string" ? thinkingLevel.toLowerCase() : "";
	return `${model}-${FLASH_TIERS.has(level) ? level : "low"}`;
}

/**
 * Normalises a thinking level onto the ones the backend accepts, or undefined
 * when the value is not a level at all.
 */
export function normalizeThinkingLevel(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const level = value.toLowerCase();
	return THINKING_LEVELS.has(level) ? level : undefined;
}

/** The generation config of a Generative Language payload, wrapped or not. */
function generationConfigOf(
	payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
	const config = payload.generationConfig ?? payload.generation_config;
	return isObject(config) ? config : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the thinking level a caller asked for out of a request body.
 *
 * The caller's level is the one from opencode's model options, and request
 * preparation overwrites it with whatever the model id implies, so it has to
 * be captured before the prepared body replaces the original one.
 */
export function requestedThinkingLevel(
	body: string | undefined,
): string | undefined {
	if (!body) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return undefined;
	}
	if (!isObject(parsed)) return undefined;
	const payload = isObject(parsed.request) ? parsed.request : parsed;
	const config = generationConfigOf(payload);
	if (!config) return undefined;
	const thinking = config.thinkingConfig ?? config.thinking_config;
	if (!isObject(thinking)) return undefined;
	return normalizeThinkingLevel(
		thinking.thinkingLevel ?? thinking.thinking_level,
	);
}

/**
 * Applies the tier and the thinking level a prepared request needs.
 *
 * Two things are undone here, both of them consequences of the upstream
 * resolver keying thinking off the model id:
 *
 * - Gemini 3 ids without a tier (`gemini-3-flash`, and versioned families sent
 *   under their bare id) get a default level of `low`, which silently
 *   downgrades a caller that asked for `high`. The caller's level is put back.
 * - A versioned family sent bare (`gemini-3.8-flash`) is not served at all, so
 *   the tier the level implies is appended (`gemini-3.8-flash-high`).
 *
 * The `…-flash-tiered` alias is left as it is: it is the id that reads the
 * level, which is exactly what the restore above makes visible. Ids carrying a
 * fixed tier keep both their id and the level that tier implies.
 *
 * Returns the serialized body and the model it sends, or undefined when
 * nothing changed or the body is not a wrapped request.
 */
export function applyThinkingTier(
	body: unknown,
	requestedLevel?: unknown,
): { body: string; model: string } | undefined {
	if (typeof body !== "string" || body.length === 0) return undefined;
	let wrapped: {
		model?: unknown;
		request?: unknown;
	};
	try {
		wrapped = JSON.parse(body) as typeof wrapped;
	} catch {
		return undefined;
	}
	if (typeof wrapped?.model !== "string") return undefined;
	const model = wrapped.model;
	// Claude and the older Gemini families take a numeric budget, which
	// preparation already resolves from the caller's own config.
	if (!/^gemini-3/i.test(model)) return undefined;

	const payload = isObject(wrapped.request) ? wrapped.request : {};
	const config = generationConfigOf(payload);
	const thinking = config
		? (config.thinkingConfig ?? config.thinking_config)
		: undefined;
	const preparedLevel = isObject(thinking)
		? normalizeThinkingLevel(thinking.thinkingLevel ?? thinking.thinking_level)
		: undefined;
	const level = normalizeThinkingLevel(requestedLevel) ?? preparedLevel;

	let nextModel = model;
	if (VERSIONED_GEMINI_3_FLASH.test(model)) {
		nextModel = tierVersionedFlashModel(model, level);
	}
	// A fixed-tier id already carries its level; anything else gets whatever the
	// caller asked for, because preparation filled in the id's default.
	const restoreLevel =
		level !== undefined &&
		!FIXED_TIER.test(nextModel) &&
		level !== preparedLevel;

	if (nextModel === model && !restoreLevel) return undefined;

	const nextRequest = restoreLevel
		? {
				...payload,
				generationConfig: {
					...(config ?? {}),
					thinkingConfig: {
						...(isObject(thinking) ? thinking : {}),
						thinkingLevel: level,
					},
				},
			}
		: payload;
	const next = restoreLevel
		? { ...wrapped, model: nextModel, request: nextRequest }
		: { ...wrapped, model: nextModel };
	return { body: JSON.stringify(next), model: nextModel };
}

/**
 * The CLI User-Agent. Only the `antigravity/cli/` prefix is load bearing; the
 * version and platform suffix are ignored by the backend.
 */
export function cliUserAgent(): string {
	return `antigravity/cli/${getAntigravityVersion()} ${process.platform}/${process.arch}`;
}

/** True when a stored or generated User-Agent already carries the CLI identity. */
export function hasCliUserAgent(userAgent: string | undefined): boolean {
	return typeof userAgent === "string" && userAgent.startsWith(CLI_UA_PREFIX);
}

/**
 * Returns the fingerprint with the CLI identity forced onto its User-Agent.
 *
 * The account fingerprint is what request preparation turns into the outgoing
 * `User-Agent`, so normalising it here is what keeps Gemini 4 Argon reachable.
 * Existing device fields are preserved: the backend also reads `deviceId` and
 * `sessionToken` from the fingerprint.
 */
export function cliFingerprint<T extends { userAgent?: string }>(
	fingerprint: T | undefined,
): T & { userAgent: string } {
	return { ...(fingerprint ?? ({} as T)), userAgent: cliUserAgent() };
}

/**
 * Rewrites the model id in a request URL, or returns the input untouched when
 * there is no model segment to rewrite. Accepts a URL string or a Request.
 */
export function rewriteRequestModel(
	input: RequestInfo | URL,
): RequestInfo | URL {
	if (typeof input === "string") return rewriteModelAliasInUrl(input);
	if (input instanceof URL) return new URL(rewriteModelAliasInUrl(input.href));
	return new Request(rewriteModelAliasInUrl(input.url), input);
}

/**
 * Rewrites stored account fingerprints to the CLI identity.
 *
 * The upstream plugin sends the fingerprint's User-Agent verbatim, and its own
 * version updater only rewrites `antigravity/<digits>`, so an account recorded
 * with the IDE identity stays on it forever. Running this once per startup
 * migrates both existing and freshly generated fingerprints, and it is
 * idempotent: already-migrated records are left alone.
 *
 * Returns the number of fingerprints rewritten.
 *
 * The path is required on purpose: the pool on disk is live user state, so a
 * caller must name it explicitly rather than fall through to the real one.
 */
export async function migrateFingerprintsToCliUserAgent(
	path: string,
): Promise<number> {
	let raw: string;
	try {
		raw = await readFile(path, "utf-8");
	} catch {
		return 0;
	}
	let storage: {
		accounts?: Array<{ fingerprint?: { userAgent?: string } }>;
	};
	try {
		storage = JSON.parse(raw) as typeof storage;
	} catch {
		return 0;
	}
	const accounts = Array.isArray(storage.accounts) ? storage.accounts : [];
	let migrated = 0;
	for (const account of accounts) {
		const fingerprint = account?.fingerprint;
		if (!fingerprint || hasCliUserAgent(fingerprint.userAgent)) continue;
		fingerprint.userAgent = cliUserAgent();
		migrated += 1;
	}
	if (migrated === 0) return 0;
	// Write through a temporary sibling so a crash cannot leave a truncated
	// account pool behind.
	const temp = `${path}.tmp`;
	await writeFile(temp, `${JSON.stringify(storage, null, 2)}\n`, {
		mode: 0o600,
	});
	await rename(temp, path);
	return migrated;
}
