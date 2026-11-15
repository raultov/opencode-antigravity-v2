/**
 * Retry timing for the responses Antigravity asks us to send again.
 *
 * The V1 plugin read the wait out of the error body before retrying; V2 has
 * no fetch takeover, so the adapter has to do it from the `http.response`
 * hook. Antigravity reports a rate limit in the JSON body, not in a
 * `Retry-After` header, and the wait it names is usually under a second:
 *
 * ```json
 * {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[
 *   {"@type":".../google.rpc.ErrorInfo",
 *    "metadata":{"quotaResetDelay":"174.617923ms"}},
 *   {"@type":".../google.rpc.RetryInfo","retryDelay":"0.174617923s"}]}}
 * ```
 *
 * Falling back to a fixed minute (which is what an absent header means) turns
 * a sub-second capacity blip into a multi-minute stall and then a failure, so
 * every retryable status is read through this module.
 */

/** Wait used when neither the body nor the headers name one. */
export const DEFAULT_RETRY_AFTER_MS = 60_000;

/** Millisecond weight of each duration unit the backends use. */
const DURATION_UNITS: Record<string, number> = {
	h: 3_600_000,
	m: 60_000,
	s: 1_000,
	ms: 1,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses a protobuf duration such as `0.174617923s`, `41s` or `1m30s`.
 * Returns undefined when the value names no duration at all.
 */
export function durationToMs(value: unknown): number | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	let total = 0;
	let matched = false;
	// Longest unit first, so `ms` is not read as a bare `m`.
	for (const match of value.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/gi)) {
		const amount = Number(match[1]);
		const unit = match[2]?.toLowerCase() ?? "";
		if (!Number.isFinite(amount)) continue;
		total += amount * (DURATION_UNITS[unit] ?? 0);
		matched = true;
	}
	return matched ? Math.round(total) : undefined;
}

/**
 * The wait a JSON error body asks for: its `RetryInfo` detail, then the
 * `quotaResetDelay` of the `ErrorInfo` that Antigravity puts beside it, then
 * the human-readable "Resets in 0s" the message carries.
 */
export function bodyRetryMs(text: string): number | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed) || !isRecord(parsed.error)) return undefined;
	const error = parsed.error;
	const details = Array.isArray(error.details) ? error.details : [];

	for (const detail of details) {
		if (!isRecord(detail)) continue;
		const type = typeof detail["@type"] === "string" ? detail["@type"] : "";
		if (!type.includes("google.rpc.RetryInfo")) continue;
		const delay = durationToMs(detail.retryDelay);
		if (delay !== undefined) return delay;
	}
	for (const detail of details) {
		if (!isRecord(detail) || !isRecord(detail.metadata)) continue;
		const delay = durationToMs(detail.metadata.quotaResetDelay);
		if (delay !== undefined) return delay;
	}
	if (typeof error.message !== "string") return undefined;
	const stated = error.message.match(/resets? in\s+([\d.]+\s*(?:ms|h|m|s))/i);
	return stated ? durationToMs(stated[1] ?? "") : undefined;
}

/** `Retry-After` in milliseconds, or undefined when the header is absent. */
export function headerRetryMs(response: Response): number | undefined {
	const header = response.headers.get("retry-after");
	if (!header) return undefined;
	const seconds = Number(header);
	return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

/** `Retry-After` in milliseconds, with the V1 fetch's default. */
export function retryAfterMs(
	response: Response,
	fallback = DEFAULT_RETRY_AFTER_MS,
): number {
	return headerRetryMs(response) ?? fallback;
}

/** The body of a response, read from a clone so the original stays readable. */
async function peekText(response: Response): Promise<string> {
	try {
		return await response.clone().text();
	} catch {
		return "";
	}
}

/**
 * The wait a retryable response names, body first, headers second, or
 * undefined when it names none.
 *
 * Antigravity's capacity limits always name their wait. A 429 that names
 * none is the backend refusing the request itself (it answers the same
 * "Resource has been exhausted (e.g. check quota)." to a request whose
 * content it rejects), so retrying it only burns time.
 */
export async function serverRetryHint(
	response: Response,
): Promise<number | undefined> {
	const text = await peekText(response);
	const fromBody = text.length > 0 ? bodyRetryMs(text) : undefined;
	if (fromBody !== undefined) return Math.max(fromBody, 0);
	return headerRetryMs(response);
}

/** The wait a retryable response asks for, with a default when it names none. */
export async function serverRetryMs(
	response: Response,
	fallback = DEFAULT_RETRY_AFTER_MS,
): Promise<number> {
	return (await serverRetryHint(response)) ?? fallback;
}

/** What the user is told about a 429 the adapter will not retry. */
const UNHINTED_RATE_LIMIT_NOTE =
	"\n\nAntigravity answered 429 without a retry delay. Its capacity limits always name one, " +
	"so this is the backend refusing the request rather than a quota running out: it was not " +
	"retried and the account was not marked rate-limited. Retrying the same request will fail the same way.";

/**
 * Returns the response with its error message explaining why it was not
 * retried. A body that is not a JSON error is returned as it was.
 */
export async function explainUnhintedRateLimit(
	response: Response,
): Promise<Response> {
	const text = await peekText(response);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return response;
	}
	if (!isRecord(parsed) || !isRecord(parsed.error)) return response;
	const message =
		typeof parsed.error.message === "string" ? parsed.error.message : "";
	const body = {
		...parsed,
		error: { ...parsed.error, message: message + UNHINTED_RATE_LIMIT_NOTE },
	};
	const headers = new Headers(response.headers);
	// The body changes length; a copied length would truncate or stall it.
	headers.delete("content-length");
	return new Response(JSON.stringify(body), {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
