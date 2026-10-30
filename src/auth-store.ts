/**
 * Read/write access to opencode's credential store.
 *
 * V2 keeps credentials in its own store and hands a plugin the active one
 * through the integration API. V1 kept them in `auth.json`, which V2 does not
 * read or write, so it is consulted only as a fallback for credentials signed
 * in under V1. Only the one provider entry of that file is touched and the
 * rest of the file is preserved.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { IntegrationDomain } from "@opencode/plugin/promise/integration";

/** The credential shape both opencode generations store per provider. */
export type StoredAuth = {
	type?: string;
	refresh?: string;
	access?: string;
	expires?: number;
};

/** `~/.local/share/opencode/auth.json`, honouring `XDG_DATA_HOME`. */
export function opencodeAuthPath(): string {
	const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
	return join(base, "opencode", "auth.json");
}

type AuthFile = Record<string, StoredAuth | undefined>;

function readAuthFile(path: string): AuthFile {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as AuthFile;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

/** Returns one provider's credential, or undefined when absent/unreadable. */
export function readProviderAuth(
	providerID: string,
	path = opencodeAuthPath(),
): StoredAuth | undefined {
	return readAuthFile(path)[providerID];
}

/** Replaces one provider's credential, leaving every other entry alone. */
export function writeProviderAuth(
	providerID: string,
	value: StoredAuth,
	path = opencodeAuthPath(),
): void {
	const file = readAuthFile(path);
	file[providerID] = value;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
}

/** The part of the V2 integration API that reads the active credential. */
export type ConnectionReader = Pick<
	IntegrationDomain["connection"],
	"active" | "resolve"
>;

/**
 * The provider's credential: the active V2 connection first, then the V1
 * `auth.json` entry.
 *
 * A V2 key or environment connection comes back as a non-OAuth credential, so
 * the caller leaves those requests to opencode's own auth.
 */
export async function readActiveAuth(
	connection: ConnectionReader,
	providerID: string,
	readFallback: (
		providerID: string,
	) => StoredAuth | undefined = readProviderAuth,
): Promise<StoredAuth | undefined> {
	const active = await connection.active(providerID).catch(() => undefined);
	if (active?.type === "env") return { type: "env" };
	if (active) {
		const value = await connection.resolve(active).catch(() => undefined);
		if (value?.type === "oauth") {
			return {
				type: "oauth",
				refresh: value.refresh,
				access: value.access,
				expires: value.expires,
			};
		}
		if (value) return { type: value.type };
	}
	return readFallback(providerID);
}
