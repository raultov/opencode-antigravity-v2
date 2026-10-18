import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProviderAuth, writeProviderAuth } from "../src/auth-store.js";
import {
	buildManagedRequest,
	endpointFor,
	type ManagerLike,
	type PipelineDeps,
	type PipelineSettings,
	settingsFrom,
} from "../src/pipeline.js";
import type { ManagedAccount, OAuthAuthDetails } from "../src/upstream.js";

const SETTINGS: PipelineSettings = {
	providerID: "google",
	accountSelectionStrategy: "sticky",
	softQuotaThresholdPercent: 100,
	softQuotaCacheTtlMs: 600_000,
	pidOffsetEnabled: false,
	maxWaitMs: 300_000,
	cliFirst: false,
};

const URL =
	"https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3-flash:streamGenerateContent";

const account = {
	index: 0,
	email: "a@example.com",
	fingerprint: { id: "fp" },
} as unknown as ManagedAccount;
const freshAuth: OAuthAuthDetails = {
	type: "oauth",
	refresh: "refresh-token",
	access: "access-token",
	expires: Date.now() + 3_600_000,
};
const expiredAuth: OAuthAuthDetails = { ...freshAuth, expires: 1 };

/** Manager stand-in whose selection results are queued. */
function manager(
	queue: Array<ManagedAccount | null | undefined>,
): ManagerLike & { saved: number } {
	const calls = { saved: 0 };
	return {
		get saved() {
			return calls.saved;
		},
		getAccountCount: () => 1,
		getCurrentOrNextForFamily: () => queue.shift() ?? null,
		areAllAccountsOverSoftQuota: () => false,
		getMinWaitTimeForSoftQuota: () => null,
		getMinWaitTimeForFamily: () => 5_000,
		markAccountCoolingDown: () => undefined,
		markRateLimited: () => undefined,
		toAuthDetails: () => expiredAuth,
		updateFromAuth: () => undefined,
		saveToDisk: async () => {
			calls.saved += 1;
		},
	};
}

type PrepareArgs = Parameters<PipelineDeps["prepare"]>;

function deps(
	overrides: Partial<PipelineDeps> = {},
): PipelineDeps & { prepared: PrepareArgs[]; slept: number[] } {
	const prepared: PrepareArgs[] = [];
	const slept: number[] = [];
	return {
		prepared,
		slept,
		log: () => undefined,
		readAuth: async () => freshAuth,
		loadManager: async () => manager([account]),
		refresh: async () => freshAuth,
		projectContext: async (auth) => ({
			auth,
			effectiveProjectId: "aicode-consumers",
		}),
		prepare: ((
			input,
			init,
			accessToken,
			projectId,
			endpoint,
			headerStyle,
			forceThinkingRecovery,
			options,
		) => {
			prepared.push([
				input,
				init,
				accessToken,
				projectId,
				endpoint,
				headerStyle,
				forceThinkingRecovery,
				options,
			] as PrepareArgs);
			return {
				request:
					"https://cloudcode-pa.googleapis.com/v1beta/models/x:streamGenerateContent",
				init: {
					method: "POST",
					headers: new Headers({ "x-test": "1" }),
					body: "{}",
				},
				streaming: true,
				requestedModel: "x",
			};
		}) as PipelineDeps["prepare"],
		now: () => 1_000_000,
		sleep: async (ms) => {
			slept.push(ms);
		},
		...overrides,
	};
}

describe("buildManagedRequest", () => {
	test("ignores requests that are not for the Generative Language API", async () => {
		const result = await buildManagedRequest(
			new Request("https://example.com/v1/models"),
			deps(),
			SETTINGS,
		);
		expect(result).toBeUndefined();
	});

	test("ignores requests when opencode holds no OAuth credential", async () => {
		const d = deps({
			readAuth: async () =>
				({ type: "api", key: "k" }) as unknown as OAuthAuthDetails,
		});
		expect(
			await buildManagedRequest(new Request(URL), d, SETTINGS),
		).toBeUndefined();
	});

	test("prepares the request with the selected account's token", async () => {
		const d = deps();
		const request = new Request(URL, {
			method: "POST",
			body: '{"a":1}',
			headers: { "x-goog-api-key": "", "content-type": "application/json" },
		});
		const built = await buildManagedRequest(request, d, SETTINGS);
		expect(built).toBeDefined();
		expect(d.prepared[0]?.[2]).toBe("access-token");
		expect(d.prepared[0]?.[5]).toBe("antigravity");
		// The provider's own (empty) API key must not survive into the prepared
		// request: Google rejects it before ever seeing the bearer token.
		const preparedHeaders = new Headers(d.prepared[0]?.[1]?.headers);
		expect(preparedHeaders.has("x-goog-api-key")).toBe(false);
		expect(preparedHeaders.has("authorization")).toBe(false);
		expect(preparedHeaders.get("content-type")).toBe("application/json");
		expect(built?.request.url).toBe(
			"https://cloudcode-pa.googleapis.com/v1beta/models/x:streamGenerateContent",
		);
		expect(built?.meta.streaming).toBe(true);
	});

	test("sends Gemini 4 Argon under the tiered id the backend serves", async () => {
		const d = deps();
		const request = new Request(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-4-argon:streamGenerateContent",
			{ method: "POST", body: "{}" },
		);
		await buildManagedRequest(request, d, SETTINGS);
		expect(String(d.prepared[0]?.[0])).toContain(
			"/models/gemini-4-argon-medium:",
		);
	});

	test("leaves tiered Argon ids untouched", async () => {
		const d = deps();
		const request = new Request(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-4-argon-high:streamGenerateContent",
			{ method: "POST", body: "{}" },
		);
		await buildManagedRequest(request, d, SETTINGS);
		expect(String(d.prepared[0]?.[0])).toContain(
			"/models/gemini-4-argon-high:",
		);
	});

	test("prepares the request with the CLI User-Agent identity", async () => {
		const d = deps();
		const request = new Request(URL, { method: "POST", body: "{}" });
		await buildManagedRequest(request, d, SETTINGS);
		const fingerprint = (
			d.prepared[0]?.[7] as { fingerprint?: { userAgent?: string } }
		)?.fingerprint;
		expect(fingerprint?.userAgent?.startsWith("antigravity/cli/")).toBe(true);
	});

	test("spends quota on the resolved project instead of an empty one", async () => {
		const d = deps();
		const request = new Request(URL, { method: "POST", body: "{}" });
		await buildManagedRequest(request, d, SETTINGS);
		expect(d.prepared[0]?.[3]).toBe("aicode-consumers");
	});

	test("keeps the turn going when the project cannot be resolved", async () => {
		const d = deps({
			projectContext: async () => {
				throw new Error("loadCodeAssist unreachable");
			},
		});
		const built = await buildManagedRequest(
			new Request(URL, { method: "POST", body: "{}" }),
			d,
			SETTINGS,
		);
		expect(built).toBeDefined();
		expect(d.prepared[0]?.[3]).toBe("");
	});

	test("refreshes an expired token and persists it", async () => {
		const pool = manager([account]);
		let refreshed = 0;
		const d = deps({
			loadManager: async () => pool,
			refresh: async () => {
				refreshed += 1;
				return freshAuth;
			},
		});
		// toAuthDetails returns the expired record, so the refresh path is taken.
		await buildManagedRequest(
			new Request(URL, { method: "POST", body: "{}" }),
			d,
			SETTINGS,
		);
		expect(refreshed).toBe(1);
		expect(pool.saved).toBe(1);
	});

	test("cools the account down when its token cannot be refreshed", async () => {
		let cooled = 0;
		let rateLimited = 0;
		const pool: ManagerLike = {
			...manager([account]),
			markAccountCoolingDown: () => {
				cooled += 1;
			},
			markRateLimited: () => {
				rateLimited += 1;
			},
		};
		const d = deps({
			loadManager: async () => pool,
			refresh: async () => undefined,
		});
		expect(
			buildManagedRequest(
				new Request(URL, { method: "POST", body: "{}" }),
				d,
				SETTINGS,
			),
		).rejects.toThrow("token refresh failed");
		expect(cooled).toBe(1);
		expect(rateLimited).toBe(1);
	});

	test("waits out a busy pool and then selects", async () => {
		// Each round tries the preferred quota style and then the fallback, so two
		// empty results buy one wait before the account turns up.
		const d = deps({
			loadManager: async () => manager([null, null, null, account]),
		});
		const built = await buildManagedRequest(
			new Request(URL, { method: "POST", body: "{}" }),
			d,
			SETTINGS,
		);
		expect(built).toBeDefined();
		expect(d.slept).toEqual([5_000]);
	});

	test("throws once the busy pool outlasts the wait budget", async () => {
		const busy = {
			...manager([null, null]),
			getMinWaitTimeForFamily: () => 999_999_999,
		};
		const d = deps({ loadManager: async () => busy });
		expect(
			buildManagedRequest(
				new Request(URL, { method: "POST", body: "{}" }),
				d,
				SETTINGS,
			),
		).rejects.toThrow("rate-limited or over quota");
	});

	test("spends Gemini CLI quota from its production endpoint", async () => {
		expect(endpointFor("gemini-cli", 3)).toBe(
			"https://cloudcode-pa.googleapis.com",
		);
		expect(endpointFor("antigravity", 0)).not.toBe(
			endpointFor("gemini-cli", 0),
		);
	});
});

describe("settingsFrom", () => {
	test("maps plugin options over the defaults", () => {
		const settings = settingsFrom({
			soft_quota_threshold_percent: 100,
			account_selection_strategy: "hybrid",
		});
		expect(settings.softQuotaThresholdPercent).toBe(100);
		expect(settings.accountSelectionStrategy).toBe("hybrid");
		expect(settings.providerID).toBe("google");
		expect(settings.maxWaitMs).toBe(300_000);
	});
});

describe("auth store", () => {
	let path: string;

	beforeEach(async () => {
		const dir = await mkdtemp(join(tmpdir(), "agv-auth-"));
		path = join(dir, "opencode", "auth.json");
	});

	test("round-trips one provider without touching the others", async () => {
		await mkdir(join(path, ".."), { recursive: true });
		await writeFile(path, JSON.stringify({ other: { type: "api", key: "k" } }));
		writeProviderAuth(
			"google",
			{ type: "oauth", refresh: "r", access: "a", expires: 1 },
			path,
		);
		expect(readProviderAuth("google", path)?.refresh).toBe("r");
		expect(readProviderAuth("other", path)?.type).toBe("api");
	});

	test("returns undefined for a missing store", () => {
		expect(
			readProviderAuth("google", join(path, "missing.json")),
		).toBeUndefined();
	});
});
