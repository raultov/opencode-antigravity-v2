import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntegrationMethodRegistration } from "@opencode/plugin/promise/integration";
import type { Plugin } from "@opencode/plugin/promise/plugin";
import { cliUserAgent } from "../src/identity.js";
import AntigravityAuthModule, {
	AntigravityAuthV1,
	createAntigravityAuthV1,
	createAntigravityAuthV2,
} from "../src/index.js";
import type { PipelineDeps } from "../src/pipeline.js";
import type { ManagedAccount, OAuthAuthDetails } from "../src/upstream.js";

// biome-ignore lint/suspicious/noExplicitAny: deliberately loose stand-in for SDK hook events
type HookHandler = (event: Record<string, any>) => Promise<void> | void;

const URL =
	"https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3-flash:streamGenerateContent";
const freshAuth: OAuthAuthDetails = {
	type: "oauth",
	refresh: "refresh-token",
	access: "access-token",
	expires: Date.now() + 3_600_000,
};
const account = {
	index: 0,
	email: "a@example.com",
} as unknown as ManagedAccount;

function managerStub() {
	return {
		marks: 0,
		getAccountCount: () => 1,
		getCurrentOrNextForFamily: () => account,
		areAllAccountsOverSoftQuota: () => false,
		getMinWaitTimeForSoftQuota: () => null,
		getMinWaitTimeForFamily: () => 5_000,
		markAccountCoolingDown: () => undefined,
		markRateLimited: () => {
			managerStubMarks += 1;
		},
		toAuthDetails: () => freshAuth,
		updateFromAuth: () => undefined,
		saveToDisk: async () => undefined,
	};
}
let managerStubMarks = 0;

function setup() {
	const hooks = new Map<string, HookHandler>();
	const methods: IntegrationMethodRegistration[] = [];
	const ctx = {
		options: {},
		session: {
			hook: async (name: string, callback: HookHandler) => {
				hooks.set(name, callback);
				return { dispose: async () => undefined };
			},
		},
		integration: {
			transform: async (
				callback: (editor: {
					method: { update: (input: IntegrationMethodRegistration) => void };
				}) => void,
			) => {
				callback({ method: { update: (input) => methods.push(input) } });
				return { dispose: async () => undefined };
			},
			connection: {
				active: async () => undefined,
				resolve: async () => undefined,
			},
		},
	};
	const overrides: Partial<PipelineDeps> = {
		log: () => undefined,
		readAuth: async () => freshAuth,
		loadManager: async () => managerStub(),
		refresh: async () => freshAuth,
		projectContext: async (auth) => ({ auth, effectiveProjectId: "project" }),
		prepare: (() => ({
			request: "https://cloudcode-pa.googleapis.com/rewritten",
			init: { method: "POST", headers: new Headers(), body: "{}" },
			streaming: false,
			headerStyle: "antigravity",
		})) as unknown as PipelineDeps["prepare"],
	};
	const plugin = createAntigravityAuthV2({
		...overrides,
		transform: async (response) => response,
	});
	return {
		hooks,
		methods,
		ctx: ctx as unknown as Parameters<Plugin["setup"]>[0],
		plugin,
	};
}

describe("AntigravityAuthV2", () => {
	test("registers the native request, response and retry hooks", async () => {
		const { hooks, ctx, plugin } = setup();
		await plugin.setup(ctx);
		expect([...hooks.keys()].sort()).toEqual([
			"http.request",
			"http.response",
			"retry",
		]);
	});

	test("registers the Antigravity sign-in on the provider's integration", async () => {
		const { methods, ctx, plugin } = setup();
		await plugin.setup(ctx);
		expect(methods).toHaveLength(1);
		expect(methods[0]?.integrationID).toBe("google");
		expect(methods[0]?.method).toMatchObject({
			type: "oauth",
			label: "OAuth with Google (Antigravity)",
		});
	});

	test("rewrites managed google requests and leaves the rest alone", async () => {
		const { hooks, ctx, plugin } = setup();
		await plugin.setup(ctx);

		const foreign = {
			sessionID: "s1",
			model: { providerID: "anthropic", id: "x" },
			request: new Request(URL),
		};
		await hooks.get("http.request")?.(foreign);
		expect(foreign.request.url).toBe(URL);

		const managed = {
			sessionID: "s1",
			model: { providerID: "google", id: "m" },
			request: new Request(URL),
		};
		await hooks.get("http.request")?.(managed);
		expect(managed.request.url).toBe(
			"https://cloudcode-pa.googleapis.com/rewritten",
		);
	});

	test("marks rate-limited responses and retries after the advertised delay", async () => {
		managerStubMarks = 0;
		const { hooks, ctx, plugin } = setup();
		await plugin.setup(ctx);

		const event = {
			sessionID: "s1",
			model: { providerID: "google", id: "m" },
			request: new Request(URL),
			response: new Response("{}", {
				status: 429,
				headers: { "retry-after": "7" },
			}),
		};
		await hooks.get("http.request")?.(event);
		await hooks.get("http.response")?.(event);
		expect(managerStubMarks).toBe(1);

		const retry = {
			sessionID: "s1",
			model: { providerID: "google", id: "m" },
			error: {},
			attempt: 1,
			decision: { retry: false } as { retry: boolean; delay?: number },
		};
		await hooks.get("retry")?.(retry);
		expect(retry.decision).toEqual({ retry: true, delay: 7_000 });
	});

	test("does not retry past the adapter's attempt budget", async () => {
		const { hooks, ctx, plugin } = setup();
		await plugin.setup(ctx);

		const request = {
			sessionID: "s1",
			model: { providerID: "google", id: "m" },
			request: new Request(URL),
		};
		await hooks.get("http.request")?.(request);
		await hooks.get("http.response")?.({
			...request,
			response: new Response("{}", { status: 429 }),
		});

		for (let attempt = 1; attempt <= 5; attempt++) {
			const retry = {
				sessionID: "s1",
				model: { providerID: "google", id: "m" },
				error: {},
				attempt,
				decision: { retry: false },
			};
			await hooks.get("retry")?.(retry);
			if (attempt <= 3) expect(retry.decision.retry).toBe(true);
			else expect(retry.decision.retry).toBe(false);
		}
	});

	test("clears retry state after a successful response", async () => {
		const { hooks, ctx, plugin } = setup();
		await plugin.setup(ctx);

		const base = {
			sessionID: "s1",
			model: { providerID: "google", id: "m" },
			request: new Request(URL),
		};
		await hooks.get("http.request")?.(base);
		await hooks.get("http.response")?.({
			...base,
			response: new Response("{}", { status: 429 }),
		});
		await hooks.get("http.request")?.(base);
		await hooks.get("http.response")?.({
			...base,
			response: new Response("{}", { status: 200 }),
		});

		const retry = {
			sessionID: "s1",
			model: { providerID: "google", id: "m" },
			error: {},
			attempt: 1,
			decision: { retry: false },
		};
		await hooks.get("retry")?.(retry);
		expect(retry.decision.retry).toBe(false);
	});
});

describe("AntigravityAuthV1", () => {
	// biome-ignore lint/suspicious/noExplicitAny: the V1 client is typed upstream against an SDK this package does not install
	type V1Input = any;

	function v1Input() {
		const logs: unknown[] = [];
		const input: V1Input = {
			client: { app: { log: async (entry: unknown) => logs.push(entry) } },
			directory: "/tmp/project",
		};
		return { input, logs };
	}

	/**
	 * Every call names its own throwaway account pool: the real one is live user
	 * state and must never be written from a test.
	 */
	async function accountsPath() {
		const dir = await mkdtemp(join(tmpdir(), "agv-v1-"));
		return join(dir, "antigravity-accounts.json");
	}

	test("the default export serves both generations", () => {
		expect(AntigravityAuthModule.id).toBe("antigravity-auth");
		expect(typeof AntigravityAuthModule.setup).toBe("function");
		expect(AntigravityAuthModule.server).toBe(AntigravityAuthV1);
	});

	test("delegates to the upstream plugin with the V1 input", async () => {
		const { input, logs } = v1Input();
		let received: unknown;
		const upstream = async (arg: unknown) => {
			received = arg;
			return { auth: { provider: "google" } };
		};
		const server = createAntigravityAuthV1(
			upstream as V1Input,
			() => "/nonexistent/antigravity-accounts.json",
		);
		const result = await server(input);
		expect(received).toBe(input);
		expect(result).toEqual({ auth: { provider: "google" } } as V1Input);
		expect(logs).toHaveLength(0);
	});

	test("reports plugin options instead of silently dropping them", async () => {
		const { input, logs } = v1Input();
		const server = createAntigravityAuthV1(
			(async () => ({})) as V1Input,
			() => "/nonexistent/antigravity-accounts.json",
		);
		await server(input, { soft_quota_threshold_percent: 100 });
		expect(logs).toHaveLength(1);
		expect(JSON.stringify(logs[0])).toContain("soft_quota_threshold_percent");
	});

	test("migrates the named account pool onto the CLI identity", async () => {
		const path = await accountsPath();
		await writeFile(
			path,
			JSON.stringify({
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
		const server = createAntigravityAuthV1(
			(async () => ({})) as V1Input,
			() => path,
		);
		await server(v1Input().input);
		const stored = JSON.parse(await readFile(path, "utf-8"));
		expect(stored.accounts[0].fingerprint.userAgent).toBe(cliUserAgent());
		expect(stored.accounts[0].fingerprint.deviceId).toBe("device");
	});

	test("aliases the model before the upstream fetch sees it", async () => {
		const seen: string[] = [];
		const upstream = async () => ({
			auth: {
				provider: "google",
				loader: async () => ({
					apiKey: "k",
					fetch: async (input: RequestInfo | URL) => {
						seen.push(String(input instanceof Request ? input.url : input));
						return new Response("{}");
					},
				}),
			},
		});
		const server = createAntigravityAuthV1(
			upstream as V1Input,
			() => "/nonexistent/antigravity-accounts.json",
		);
		const result = await server(v1Input().input);
		const loader = (result as { auth: { loader: unknown } }).auth.loader as (
			getAuth: unknown,
			provider: unknown,
		) => Promise<{ fetch: (input: RequestInfo | URL) => Promise<Response> }>;
		const { fetch } = await loader(() => undefined, {});
		await fetch(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-4-argon:streamGenerateContent",
		);
		expect(seen[0]).toContain("/models/gemini-4-argon-medium:");
	});
});
