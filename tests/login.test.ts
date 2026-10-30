import { describe, expect, test } from "bun:test";
import type { IntegrationOAuthAuthorization } from "@opencode/plugin/promise/integration";
import {
	addAccountToPool,
	isRemoteSession,
	type LoginDeps,
	loginMethod,
	parseCallbackInput,
} from "../src/login.js";
import type { AccountStorageV4 } from "../src/upstream.js";

const AUTH_URL =
	"https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=abc";
const success = {
	type: "success" as const,
	refresh: "rt|proj",
	access: "at",
	expires: 123,
	email: "user-17@masked.invalid",
	projectId: "proj",
};

function deps(overrides: Partial<LoginDeps> = {}) {
	const added: unknown[] = [];
	const exchanged: Array<[string, string]> = [];
	const closed: number[] = [];
	const value: LoginDeps & {
		added: unknown[];
		exchanged: Array<[string, string]>;
		closed: number[];
	} = {
		added,
		exchanged,
		closed,
		authorize: async () => ({ url: AUTH_URL, verifier: "v", projectId: "" }),
		exchange: async (code, state) => {
			exchanged.push([code, state]);
			return success;
		},
		startListener: async () => ({
			waitForCallback: async () =>
				new URL("http://localhost:51121/oauth-callback?code=c1&state=abc"),
			close: async () => {
				closed.push(1);
			},
		}),
		addAccount: async (result) => {
			added.push(result);
		},
		refresh: async (auth) => ({ ...auth, access: "new", expires: 999 }),
		remote: () => false,
		now: () => 1_000,
		...overrides,
	};
	return value;
}

async function authorize(d: LoginDeps): Promise<IntegrationOAuthAuthorization> {
	return loginMethod("google", d).authorize({});
}

describe("loginMethod", () => {
	test("detects the browser redirect locally and adds the account", async () => {
		const d = deps();
		const authorization = await authorize(d);
		expect(authorization.mode).toBe("auto");
		expect(authorization.url).toBe(AUTH_URL);
		if (authorization.mode !== "auto") throw new Error("expected auto");
		const credential = await authorization.callback;
		expect(d.exchanged).toEqual([["c1", "abc"]]);
		expect(d.added).toEqual([success]);
		expect(d.closed).toHaveLength(1);
		expect(credential).toMatchObject({
			type: "oauth",
			methodID: "antigravity",
			refresh: "rt|proj",
			access: "at",
			expires: 123,
			metadata: { email: "user-17@masked.invalid" },
		});
	});

	test("asks for the redirect URL on a remote session", async () => {
		let started = false;
		const d = deps({
			remote: () => true,
			startListener: async () => {
				started = true;
				throw new Error("unused");
			},
		});
		const authorization = await authorize(d);
		expect(started).toBe(false);
		if (authorization.mode !== "code") throw new Error("expected code");
		await authorization.callback(
			"http://localhost:51121/oauth-callback?code=c2&state=abc",
		);
		expect(d.exchanged).toEqual([["c2", "abc"]]);
		expect(d.added).toHaveLength(1);
	});

	test("falls back to pasting when the listener cannot start", async () => {
		const d = deps({
			startListener: async () => {
				throw new Error("EADDRINUSE");
			},
		});
		const authorization = await authorize(d);
		if (authorization.mode !== "code") throw new Error("expected code");
		await authorization.callback("bare-code");
		expect(d.exchanged).toEqual([["bare-code", "abc"]]);
	});

	test("fails the sign-in and keeps the pool untouched on a failed exchange", async () => {
		const d = deps({
			remote: () => true,
			exchange: async () => ({ type: "failed", error: "invalid_grant" }),
		});
		const authorization = await authorize(d);
		if (authorization.mode !== "code") throw new Error("expected code");
		await expect(authorization.callback("c")).rejects.toThrow("invalid_grant");
		expect(d.added).toHaveLength(0);
	});

	test("refreshes the stored credential through the upstream refresher", async () => {
		const method = loginMethod("google", deps());
		const refreshed = await method.refresh?.({
			type: "oauth",
			methodID: "antigravity",
			refresh: "rt",
			access: "old",
			expires: 1,
			metadata: { email: "user-17@masked.invalid" },
		} as unknown as Parameters<NonNullable<typeof method.refresh>>[0]);
		expect(refreshed).toMatchObject({
			access: "new",
			expires: 999,
			metadata: { email: "user-17@masked.invalid" },
		});
	});
});

describe("parseCallbackInput", () => {
	test("reads code and state from a redirect URL", () => {
		expect(
			parseCallbackInput("http://localhost/cb?code=c&state=s", "fallback"),
		).toEqual({ code: "c", state: "s" });
	});

	test("pairs a bare code with the authorization state", () => {
		expect(parseCallbackInput(" c ", "s")).toEqual({ code: "c", state: "s" });
	});

	test("rejects empty input and a bare code without state", () => {
		expect(() => parseCallbackInput("  ", "s")).toThrow();
		expect(() => parseCallbackInput("c", "")).toThrow("full redirect URL");
	});
});

describe("isRemoteSession", () => {
	test("treats SSH and explicit headless mode as remote", () => {
		expect(isRemoteSession({ SSH_CONNECTION: "1" })).toBe(true);
		expect(isRemoteSession({ OPENCODE_HEADLESS: "1" })).toBe(true);
	});

	test("does not treat a missing display as remote", () => {
		expect(isRemoteSession({})).toBe(false);
	});
});

describe("addAccountToPool", () => {
	function store(initial: AccountStorageV4 | null) {
		const saved: AccountStorageV4[] = [];
		return {
			saved,
			load: async () => initial,
			save: async (storage: AccountStorageV4) => {
				saved.push(storage);
			},
		};
	}

	test("creates the pool on a fresh machine", async () => {
		const s = store(null);
		await addAccountToPool(success, s, 50);
		expect(s.saved[0]).toEqual({
			version: 4,
			accounts: [
				{
					email: "user-17@masked.invalid",
					refreshToken: "rt",
					projectId: "proj",
					managedProjectId: undefined,
					addedAt: 50,
					lastUsed: 50,
					enabled: true,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: { claude: 0, gemini: 0 },
		});
	});

	test("appends a new account and keeps the active one", async () => {
		const s = store({
			version: 4,
			accounts: [
				{
					email: "user-18@masked.invalid",
					refreshToken: "o",
					addedAt: 1,
					lastUsed: 1,
				},
			],
			activeIndex: 0,
		});
		await addAccountToPool(success, s, 50);
		expect(s.saved[0]?.accounts.map((a) => a.email)).toEqual([
			"user-18@masked.invalid",
			"user-17@masked.invalid",
		]);
		expect(s.saved[0]?.activeIndex).toBe(0);
	});

	test("replaces the token of an account signed in again", async () => {
		const s = store({
			version: 4,
			accounts: [
				{
					email: "user-17@masked.invalid",
					refreshToken: "old",
					managedProjectId: "managed",
					addedAt: 1,
					lastUsed: 1,
					enabled: false,
				},
			],
			activeIndex: 0,
		});
		await addAccountToPool(success, s, 50);
		expect(s.saved[0]?.accounts).toHaveLength(1);
		expect(s.saved[0]?.accounts[0]).toMatchObject({
			refreshToken: "rt",
			managedProjectId: "managed",
			addedAt: 1,
			lastUsed: 50,
			enabled: false,
		});
	});
});
