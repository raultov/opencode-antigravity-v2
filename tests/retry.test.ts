import { describe, expect, test } from "bun:test";
import {
	bodyRetryMs,
	DEFAULT_RETRY_AFTER_MS,
	durationToMs,
	headerRetryMs,
	retryAfterMs,
	serverRetryMs,
} from "../src/retry.js";

/** The body Antigravity sends when a model is momentarily at capacity. */
const capacityBody = (delay: string, retryDelay: string) =>
	JSON.stringify({
		error: {
			code: 429,
			message: "You have exhausted your capacity on this model. Resets in 0s.",
			status: "RESOURCE_EXHAUSTED",
			details: [
				{
					"@type": "type.googleapis.com/google.rpc.ErrorInfo",
					reason: "RATE_LIMIT_EXCEEDED",
					metadata: {
						model: "gemini-3.8-flash-tiered",
						quotaResetDelay: delay,
						quotaResetTimeStamp: "2026-11-15T08:37:34Z",
					},
				},
				{
					"@type": "type.googleapis.com/google.rpc.RetryInfo",
					retryDelay,
				},
			],
		},
	});

describe("durationToMs", () => {
	test("parses the units the backend uses", () => {
		expect(durationToMs("174.617923ms")).toBe(175);
		expect(durationToMs("0.174617923s")).toBe(175);
		expect(durationToMs("41s")).toBe(41_000);
		expect(durationToMs("1m30s")).toBe(90_000);
		expect(durationToMs("2h")).toBe(7_200_000);
	});

	test("rejects values that name no duration", () => {
		expect(durationToMs(undefined)).toBeUndefined();
		expect(durationToMs("")).toBeUndefined();
		expect(durationToMs("soon")).toBeUndefined();
		expect(durationToMs(5)).toBeUndefined();
	});
});

describe("bodyRetryMs", () => {
	test("prefers the RetryInfo delay", () => {
		expect(bodyRetryMs(capacityBody("900ms", "0.175s"))).toBe(175);
	});

	test("falls back to the ErrorInfo quotaResetDelay", () => {
		const body = JSON.stringify({
			error: {
				code: 429,
				status: "RESOURCE_EXHAUSTED",
				details: [
					{
						"@type": "type.googleapis.com/google.rpc.ErrorInfo",
						metadata: { quotaResetDelay: "2.5s" },
					},
				],
			},
		});
		expect(bodyRetryMs(body)).toBe(2_500);
	});

	test("falls back to the reset the message names", () => {
		const body = JSON.stringify({
			error: {
				code: 429,
				message: "Quota exceeded. Resets in 12s.",
				status: "RESOURCE_EXHAUSTED",
			},
		});
		expect(bodyRetryMs(body)).toBe(12_000);
	});

	test("returns undefined when the body names no wait", () => {
		expect(bodyRetryMs("not json")).toBeUndefined();
		expect(bodyRetryMs("{}")).toBeUndefined();
		expect(
			bodyRetryMs(
				JSON.stringify({
					error: { code: 429, message: "Resource has been exhausted." },
				}),
			),
		).toBeUndefined();
	});
});

describe("headerRetryMs", () => {
	test("reads the header in seconds", () => {
		expect(
			headerRetryMs(new Response("{}", { headers: { "retry-after": "7" } })),
		).toBe(7_000);
	});

	test("ignores a missing or unusable header", () => {
		expect(headerRetryMs(new Response("{}"))).toBeUndefined();
		expect(
			headerRetryMs(new Response("{}", { headers: { "retry-after": "soon" } })),
		).toBeUndefined();
	});
});

describe("retryAfterMs", () => {
	test("keeps the V1 fetch's default when the server names nothing", () => {
		expect(retryAfterMs(new Response("{}"))).toBe(DEFAULT_RETRY_AFTER_MS);
	});
});

describe("serverRetryMs", () => {
	test("uses the sub-second wait the body asks for", async () => {
		const response = new Response(
			capacityBody("174.617923ms", "0.174617923s"),
			{
				status: 429,
			},
		);
		expect(await serverRetryMs(response)).toBe(175);
	});

	test("prefers the body over the header", async () => {
		const response = new Response(capacityBody("900ms", "0.5s"), {
			status: 429,
			headers: { "retry-after": "60" },
		});
		expect(await serverRetryMs(response)).toBe(500);
	});

	test("falls back to the header, then to the default", async () => {
		expect(
			await serverRetryMs(
				new Response("{}", { status: 429, headers: { "retry-after": "3" } }),
			),
		).toBe(3_000);
		expect(await serverRetryMs(new Response("{}", { status: 429 }))).toBe(
			DEFAULT_RETRY_AFTER_MS,
		);
	});

	test("leaves the response body readable", async () => {
		const response = new Response(capacityBody("174ms", "0.174s"), {
			status: 429,
		});
		await serverRetryMs(response);
		expect(await response.text()).toContain("RESOURCE_EXHAUSTED");
	});
});
