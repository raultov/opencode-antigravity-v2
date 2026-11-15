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

/**
 * The wait a retryable response asks for, body first, headers second.
 *
 * The body is cloned so the response keeps streaming to opencode and to the
 * response transformer untouched.
 */
export async function serverRetryMs(
	response: Response,
	fallback = DEFAULT_RETRY_AFTER_MS,
): Promise<number> {
	let text = "";
	try {
		text = await response.clone().text();
	} catch {
		text = "";
	}
	const fromBody = text.length > 0 ? bodyRetryMs(text) : undefined;
	if (fromBody !== undefined) return Math.max(fromBody, 0);
	return retryAfterMs(response, fallback);
}
