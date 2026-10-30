/**
 * Bindings to the `opencode-antigravity-auth` package internals.
 *
 * That package is a V1 plugin: its export surface is the V1 plugin factory,
 * but the compiled modules underneath export the machinery this adapter needs
 * (account pool, token refresh, request preparation, response transformation).
 * Those are imported by path on purpose — the package has no exports map, so
 * every compiled module is reachable and its sibling `.d.ts` keeps this typed.
 *
 * `extractModelFromUrl` and `getModelFamilyFromUrl` are the only pieces that
 * live inside the V1 fetch closure without an export; they are two-line URL
 * parsers and are reimplemented here verbatim.
 */
import { __testExports } from "opencode-antigravity-auth/dist/src/plugin.js";

export type { AntigravityTokenExchangeResult } from "opencode-antigravity-auth/dist/src/antigravity/oauth.js";
export {
	authorizeAntigravity,
	exchangeAntigravity,
} from "opencode-antigravity-auth/dist/src/antigravity/oauth.js";
export {
	ANTIGRAVITY_ENDPOINT_FALLBACKS,
	ANTIGRAVITY_ENDPOINT_PROD,
	GEMINI_CLI_ENDPOINT,
} from "opencode-antigravity-auth/dist/src/constants.js";
export type { ManagedAccount } from "opencode-antigravity-auth/dist/src/plugin/accounts.js";
export { AccountManager } from "opencode-antigravity-auth/dist/src/plugin/accounts.js";
export {
	accessTokenExpired,
	isOAuthAuth,
	parseRefreshParts,
} from "opencode-antigravity-auth/dist/src/plugin/auth.js";
export type { AntigravityConfig } from "opencode-antigravity-auth/dist/src/plugin/config/index.js";
export { loadConfig } from "opencode-antigravity-auth/dist/src/plugin/config/index.js";
export { ensureProjectContext } from "opencode-antigravity-auth/dist/src/plugin/project.js";
export {
	isGenerativeLanguageRequest,
	prepareAntigravityRequest,
	transformAntigravityResponse,
} from "opencode-antigravity-auth/dist/src/plugin/request.js";
export type { OAuthListener } from "opencode-antigravity-auth/dist/src/plugin/server.js";
export { startOAuthListener } from "opencode-antigravity-auth/dist/src/plugin/server.js";
export type { AccountStorageV4 } from "opencode-antigravity-auth/dist/src/plugin/storage.js";
export {
	getStoragePath,
	loadAccounts,
	saveAccounts,
} from "opencode-antigravity-auth/dist/src/plugin/storage.js";
export {
	AntigravityTokenRefreshError,
	refreshAccessToken,
} from "opencode-antigravity-auth/dist/src/plugin/token.js";
export type {
	OAuthAuthDetails,
	ProjectContextResult,
} from "opencode-antigravity-auth/dist/src/plugin/types.js";

/** Header routing (which quota pool a request spends), as the V1 fetch used it. */
export const resolveHeaderRoutingDecision: (
	urlString: string,
	family: "claude" | "gemini",
	config: { cli_first?: boolean },
) => {
	cliFirst: boolean;
	preferredHeaderStyle: "antigravity" | "gemini-cli";
	explicitQuota: boolean;
	allowQuotaFallback: boolean;
} = __testExports.resolveHeaderRoutingDecision;

/** The model id in a `generativelanguage.googleapis.com` URL. */
export function extractModelFromUrl(urlString: string): string | null {
	const match = urlString.match(/\/models\/([^:/?]+)(?::\w+)?/);
	return match?.[1] ?? null;
}

/** Claude requests spend Claude quota; everything else is the Gemini family. */
export function getModelFamilyFromUrl(urlString: string): "claude" | "gemini" {
	const model = extractModelFromUrl(urlString);
	return model?.includes("claude") ? "claude" : "gemini";
}
