/**
 * Read/write access to opencode's credential store.
 *
 * The V1 plugin received the provider credential through its `auth` hook and
 * persisted account updates through the client. This adapter runs server-side
 * in V2, which exposes no credential API to plugins, so the same file opencode
 * persists to is used directly. Only the one provider entry is touched and the
 * rest of the file is preserved.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
