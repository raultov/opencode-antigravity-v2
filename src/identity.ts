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
 * `gemini-4-argon` opencode lists is not a valid id at all.
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
