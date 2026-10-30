import { beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cliFingerprint,
	cliUserAgent,
	hasCliUserAgent,
	migrateFingerprintsToCliUserAgent,
	resolveModelAlias,
	rewriteModelAliasInUrl,
	rewriteRequestModel,
	tierVersionedFlashBody,
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

describe("tierVersionedFlashBody", () => {
	const wrapped = (model: string, thinkingLevel?: string) =>
		JSON.stringify({
			project: "p",
			model,
			request: {
				contents: [],
				generationConfig: { thinkingConfig: { thinkingLevel } },
			},
		});

	test("rewrites only the model of a wrapped body", () => {
		const tiered = tierVersionedFlashBody(wrapped("gemini-3.8-flash", "high"));
		expect(tiered?.model).toBe("gemini-3.8-flash-high");
		const body = JSON.parse(tiered?.body ?? "{}");
		expect(body.model).toBe("gemini-3.8-flash-high");
		expect(body.project).toBe("p");
		expect(body.request.generationConfig.thinkingConfig.thinkingLevel).toBe(
			"high",
		);
	});

	test("returns undefined when nothing needs a tier", () => {
		expect(tierVersionedFlashBody(wrapped("gemini-3-flash", "low"))).toBe(
			undefined,
		);
		expect(tierVersionedFlashBody("not json")).toBeUndefined();
		expect(tierVersionedFlashBody(undefined)).toBeUndefined();
		expect(tierVersionedFlashBody("{}")).toBeUndefined();
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
