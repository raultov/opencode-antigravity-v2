import { beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyThinkingTier,
	cliFingerprint,
	cliUserAgent,
	hasCliUserAgent,
	migrateFingerprintsToCliUserAgent,
	normalizeThinkingLevel,
	requestedThinkingLevel,
	resolveModelAlias,
	rewriteModelAliasInUrl,
	rewriteRequestModel,
	tierVersionedFlashModel,
} from "../src/identity.js";

describe("resolveModelAlias", () => {
	test("maps the bare Gemini 4 Argon id onto a tiered one", () => {
		expect(resolveModelAlias("gemini-4-argon")).toBe("gemini-4-argon-medium");
	});

	test("keeps tiered Argon ids as they are", () => {
		for (const id of [
			"gemini-4-argon-low",
			"gemini-4-argon-medium",
			"gemini-4-argon-high",
		]) {
			expect(resolveModelAlias(id)).toBe(id);
		}
	});

	test("leaves every other model alone", () => {
		for (const id of [
			"gemini-3.8-flash-tiered",
			"claude-opus-5-5-medium",
			"gemini-3.1-pro-low",
		]) {
			expect(resolveModelAlias(id)).toBe(id);
		}
	});
});

describe("rewriteModelAliasInUrl", () => {
	test("rewrites only the model segment", () => {
		expect(
			rewriteModelAliasInUrl(
				"https://generativelanguage.googleapis.com/v1beta/models/gemini-4-argon:streamGenerateContent?alt=sse",
			),
		).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-4-argon-medium:streamGenerateContent?alt=sse",
		);
	});

	test("leaves URLs without a model segment untouched", () => {
		const url = "https://example.com/v1beta:loadCodeAssist";
		expect(rewriteModelAliasInUrl(url)).toBe(url);
	});

	test("rewrites a Request by its URL", () => {
		const input = new Request(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-4-argon:generateContent",
			{ method: "POST", body: "{}" },
		);
		const rewritten = rewriteRequestModel(input) as Request;
		expect(rewritten.url).toContain("/models/gemini-4-argon-medium:");
		expect(rewritten.method).toBe("POST");
	});
});

describe("tierVersionedFlashModel", () => {
	test("tiers a versioned flash id by its thinking level", () => {
		expect(tierVersionedFlashModel("gemini-3.8-flash", "high")).toBe(
			"gemini-3.8-flash-high",
		);
		expect(tierVersionedFlashModel("gemini-3.8-flash", "MEDIUM")).toBe(
			"gemini-3.8-flash-medium",
		);
	});

	test("falls back to low when the level has no tier", () => {
		expect(tierVersionedFlashModel("gemini-3.8-flash", undefined)).toBe(
			"gemini-3.8-flash-low",
		);
		expect(tierVersionedFlashModel("gemini-3.8-flash", "minimal")).toBe(
			"gemini-3.8-flash-low",
		);
	});

	test("leaves every other model alone", () => {
		for (const id of [
			"gemini-3-flash",
			"gemini-3.8-flash-medium",
			"gemini-3.8-flash-preview",
			"gemini-3.1-pro-low",
			"gemini-4-argon-medium",
		]) {
			expect(tierVersionedFlashModel(id, "high")).toBe(id);
		}
	});
});

describe("applyThinkingTier", () => {
	const wrapped = (model: string, thinkingLevel?: string) =>
		JSON.stringify({
			project: "p",
			model,
			request: {
				contents: [],
				generationConfig: { thinkingConfig: { thinkingLevel } },
			},
		});

	test("rewrites only the model of a bare versioned flash id", () => {
		const tiered = applyThinkingTier(wrapped("gemini-3.8-flash", "high"));
		expect(tiered?.model).toBe("gemini-3.8-flash-high");
		const body = JSON.parse(tiered?.body ?? "{}");
		expect(body.model).toBe("gemini-3.8-flash-high");
		expect(body.project).toBe("p");
		expect(body.request.generationConfig.thinkingConfig.thinkingLevel).toBe(
			"high",
		);
	});

	test("restores the requested level on the tiered alias, keeping its id", () => {
		// Preparation writes the id's default level, so the caller's high is
		// gone by the time the body reaches here.
		const tiered = applyThinkingTier(
			wrapped("gemini-3.8-flash-tiered", "low"),
			"high",
		);
		expect(tiered?.model).toBe("gemini-3.8-flash-tiered");
		const body = JSON.parse(tiered?.body ?? "{}");
		expect(body.model).toBe("gemini-3.8-flash-tiered");
		expect(body.request.generationConfig.thinkingConfig.thinkingLevel).toBe(
			"high",
		);
	});

	test("keeps includeThoughts while restoring the level", () => {
		const prepared = JSON.stringify({
			model: "gemini-3.8-flash-tiered",
			request: {
				generationConfig: {
					maxOutputTokens: 65536,
					thinkingConfig: { includeThoughts: true, thinkingLevel: "low" },
				},
			},
		});
		const tiered = applyThinkingTier(prepared, "medium");
		const body = JSON.parse(tiered?.body ?? "{}");
		expect(body.request.generationConfig.thinkingConfig).toEqual({
			includeThoughts: true,
			thinkingLevel: "medium",
		});
		expect(body.request.generationConfig.maxOutputTokens).toBe(65536);
	});

	test("leaves a fixed-tier id alone", () => {
		expect(
			applyThinkingTier(wrapped("gemini-3.8-flash-high", "high"), "high"),
		).toBe(undefined);
		expect(
			applyThinkingTier(wrapped("gemini-4-argon-low", "low"), "high"),
		).toBe(undefined);
	});

	test("restores the requested level on an unversioned Gemini 3 id", () => {
		const restored = applyThinkingTier(
			wrapped("gemini-3-flash", "low"),
			"high",
		);
		expect(restored?.model).toBe("gemini-3-flash");
		const body = JSON.parse(restored?.body ?? "{}");
		expect(body.request.generationConfig.thinkingConfig.thinkingLevel).toBe(
			"high",
		);
	});

	test("returns undefined when nothing changes", () => {
		expect(applyThinkingTier(wrapped("gemini-3-flash", "low"))).toBeUndefined();
		expect(applyThinkingTier(wrapped("claude-opus-5-5-medium", "low"))).toBe(
			undefined,
		);
		expect(applyThinkingTier(wrapped("gemini-2.5-pro", "low"))).toBeUndefined();
		expect(applyThinkingTier("not json")).toBeUndefined();
		expect(applyThinkingTier(undefined)).toBeUndefined();
		expect(applyThinkingTier("{}")).toBeUndefined();
	});
});

describe("requestedThinkingLevel", () => {
	test("reads the level out of a plain request body", () => {
		expect(
			requestedThinkingLevel(
				JSON.stringify({
					contents: [],
					generationConfig: { thinkingConfig: { thinkingLevel: "HIGH" } },
				}),
			),
		).toBe("high");
	});

	test("reads the level out of a wrapped body and snake_case fields", () => {
		expect(
			requestedThinkingLevel(
				JSON.stringify({
					request: {
						generation_config: {
							thinking_config: { thinking_level: "medium" },
						},
					},
				}),
			),
		).toBe("medium");
	});

	test("ignores bodies without a usable level", () => {
		expect(requestedThinkingLevel(undefined)).toBeUndefined();
		expect(requestedThinkingLevel("not json")).toBeUndefined();
		expect(requestedThinkingLevel("{}")).toBeUndefined();
		expect(
			requestedThinkingLevel(
				JSON.stringify({
					generationConfig: { thinkingConfig: { thinkingBudget: 8192 } },
				}),
			),
		).toBeUndefined();
	});
});

describe("normalizeThinkingLevel", () => {
	test("accepts the levels the backend knows and rejects everything else", () => {
		expect(normalizeThinkingLevel("High")).toBe("high");
		expect(normalizeThinkingLevel("minimal")).toBe("minimal");
		expect(normalizeThinkingLevel("extreme")).toBeUndefined();
		expect(normalizeThinkingLevel(3)).toBeUndefined();
	});
});

describe("CLI identity", () => {
	test("builds a User-Agent the backend recognises as the CLI", () => {
		expect(hasCliUserAgent(cliUserAgent())).toBe(true);
		expect(cliUserAgent().startsWith("antigravity/cli/")).toBe(true);
	});

	test("does not recognise the IDE identity", () => {
		expect(hasCliUserAgent("antigravity/2.0.6 win32/arm64")).toBe(false);
		expect(hasCliUserAgent(undefined)).toBe(false);
	});

	test("forces the CLI identity onto a fingerprint and keeps its device fields", () => {
		const fingerprint = cliFingerprint({
			deviceId: "device",
			sessionToken: "token",
			userAgent: "antigravity/2.0.6 win32/arm64",
		});
		expect(fingerprint.userAgent).toBe(cliUserAgent());
		expect(fingerprint.deviceId).toBe("device");
		expect(fingerprint.sessionToken).toBe("token");
	});

	test("accepts a fingerprint that was never recorded", () => {
		expect(cliFingerprint(undefined).userAgent).toBe(cliUserAgent());
	});
});

describe("migrateFingerprintsToCliUserAgent", () => {
	let path: string;

	beforeEach(async () => {
		const dir = await mkdtemp(join(tmpdir(), "agv-identity-"));
		path = join(dir, "antigravity-accounts.json");
	});

	test("rewrites IDE fingerprints and leaves the rest of the record intact", async () => {
		await writeFile(
			path,
			JSON.stringify({
				version: 4,
				accounts: [
					{
						email: "a@example.com",
						fingerprint: {
							deviceId: "device",
							userAgent: "antigravity/2.0.6 win32/arm64",
						},
					},
				],
			}),
		);
		expect(await migrateFingerprintsToCliUserAgent(path)).toBe(1);
		const stored = JSON.parse(await readFile(path, "utf-8"));
		expect(stored.accounts[0].fingerprint.userAgent).toBe(cliUserAgent());
		expect(stored.accounts[0].fingerprint.deviceId).toBe("device");
		expect(stored.accounts[0].email).toBe("a@example.com");
	});

	test("is idempotent and keeps the file mode restrictive", async () => {
		await writeFile(
			path,
			JSON.stringify({
				accounts: [
					{ fingerprint: { userAgent: "antigravity/2.0.6 win32/arm64" } },
				],
			}),
		);
		await migrateFingerprintsToCliUserAgent(path);
		expect(await migrateFingerprintsToCliUserAgent(path)).toBe(0);
		const { mode } = await stat(path);
		expect(mode & 0o777).toBe(0o600);
	});

	test("does nothing when there is no account pool yet", async () => {
		expect(await migrateFingerprintsToCliUserAgent(join(path, "missing"))).toBe(
			0,
		);
	});

	test("survives a corrupted account pool", async () => {
		await writeFile(path, "not json");
		expect(await migrateFingerprintsToCliUserAgent(path)).toBe(0);
	});

	test("leaves an already migrated pool alone", async () => {
		await writeFile(
			path,
			JSON.stringify({
				accounts: [{ fingerprint: { userAgent: cliUserAgent() } }],
			}),
		);
		await chmod(path, 0o644);
		expect(await migrateFingerprintsToCliUserAgent(path)).toBe(0);
	});
});
