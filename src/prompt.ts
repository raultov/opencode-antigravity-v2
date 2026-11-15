/**
 * System prompt text the Antigravity backend refuses.
 *
 * The backend answers a request whose `systemInstruction` contains
 * `tools.opencode.session_move` (any case) with a 429 that names no wait —
 * "Resource has been exhausted (e.g. check quota)." — every time, whatever
 * the quota. opencode V2 puts that text in every system prompt: its built-in
 * `opencode.tools` plugin adds a worktree hint naming it on each turn, and the
 * Code Mode catalog lists it as a pinned tool. Neither can be turned off from
 * configuration, so without this rewrite no opencode V2 turn gets through.
 *
 * The reference is rewritten as the equivalent bracket access
 * (`tools.opencode["session_move"]`), which the backend accepts and which
 * means exactly the same call inside `execute`, so the model keeps the tool.
 * Only the system instruction is touched: the same text in the conversation,
 * in tool calls or in tool descriptions is accepted, and the user's words are
 * not the adapter's to change. See UPSTREAM.md §6.
 */
type JsonObject = Record<string, unknown>;

/** Dotted references the backend refuses inside a system instruction. */
const REFUSED_REFERENCE = /\b(tools\.opencode)\.(session_move)\b/gi;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rewrites one text, returning it with the number of references changed. */
function rewriteText(text: string): { text: string; count: number } {
	let count = 0;
	const rewritten = text.replace(
		REFUSED_REFERENCE,
		(_match, namespace: string, name: string) => {
			count += 1;
			return `${namespace}["${name}"]`;
		},
	);
	return { text: rewritten, count };
}

/**
 * Rewrites a system instruction in place, whether it is a plain string or a
 * `{ parts: [{ text }] }` content. Returns the replacement value (strings are
 * immutable) and the number of references changed.
 */
function rewriteInstruction(instruction: unknown): {
	value: unknown;
	count: number;
} {
	if (typeof instruction === "string") {
		const { text, count } = rewriteText(instruction);
		return { value: text, count };
	}
	if (!isObject(instruction) || !Array.isArray(instruction.parts)) {
		return { value: instruction, count: 0 };
	}
	let count = 0;
	for (const part of instruction.parts) {
		if (!isObject(part) || typeof part.text !== "string") continue;
		const rewritten = rewriteText(part.text);
		part.text = rewritten.text;
		count += rewritten.count;
	}
	return { value: instruction, count };
}

/**
 * Rewrites the refused references in the system instruction of a request
 * body, wrapped (`{ request }`) or direct.
 *
 * Returns the serialized body and how many references were rewritten, or
 * undefined when there is nothing to rewrite.
 */
export function rewriteRefusedSystemText(
	body: string,
): { body: string; rewritten: number } | undefined {
	if (body.length === 0) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return undefined;
	}
	if (!isObject(parsed)) return undefined;
	const payload = isObject(parsed.request) ? parsed.request : parsed;

	let rewritten = 0;
	for (const key of ["systemInstruction", "system_instruction"]) {
		if (!(key in payload)) continue;
		const { value, count } = rewriteInstruction(payload[key]);
		payload[key] = value;
		rewritten += count;
	}

	if (rewritten === 0) return undefined;
	return { body: JSON.stringify(parsed), rewritten };
}
