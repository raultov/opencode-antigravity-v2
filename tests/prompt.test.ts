import { describe, expect, test } from "bun:test";
import { rewriteRefusedSystemText } from "../src/prompt.js";

/** The hint opencode V2's built-in `opencode.tools` plugin adds every turn. */
const HINT =
	"When you create a worktree outside the current working directory and intend to use it as your primary working directory, consider using `execute` to call `tools.opencode.session_move` and make the worktree the session's working directory.";

const body = (
	systemInstruction: unknown,
	extra: Record<string, unknown> = {},
) =>
	JSON.stringify({
		contents: [{ role: "user", parts: [{ text: "hi" }] }],
		systemInstruction,
		...extra,
	});

describe("rewriteRefusedSystemText", () => {
	test("rewrites the session_move reference as the equivalent bracket access", () => {
		const rewritten = rewriteRefusedSystemText(
			body({ parts: [{ text: "intro" }, { text: HINT }] }),
		);
		expect(rewritten?.rewritten).toBe(1);
		const parsed = JSON.parse(rewritten?.body ?? "{}");
		expect(parsed.systemInstruction.parts[0].text).toBe("intro");
		expect(parsed.systemInstruction.parts[1].text).toContain(
			'`tools.opencode["session_move"]`',
		);
		expect(parsed.systemInstruction.parts[1].text).not.toMatch(
			/tools\.opencode\.session_move/i,
		);
	});

	test("rewrites every occurrence, whatever the case", () => {
		const rewritten = rewriteRefusedSystemText(
			body({
				parts: [
					{
						text: "  - tools.opencode.session_move({\n…\nTools.Opencode.Session_Move",
					},
					{ text: HINT },
				],
			}),
		);
		expect(rewritten?.rewritten).toBe(3);
		const text = JSON.parse(rewritten?.body ?? "{}")
			.systemInstruction.parts.map((part: { text: string }) => part.text)
			.join("\n");
		expect(text).not.toMatch(/tools\.opencode\.session_move/i);
		expect(text).toContain('tools.opencode["session_move"]({');
		expect(text).toContain('Tools.Opencode["Session_Move"]');
	});

	test("leaves the conversation and the tools untouched", () => {
		const mention = "I will call tools.opencode.session_move now";
		const rewritten = rewriteRefusedSystemText(
			body(
				{ parts: [{ text: HINT }] },
				{
					contents: [
						{ role: "user", parts: [{ text: mention }] },
						{ role: "model", parts: [{ text: mention }] },
					],
					tools: [
						{
							functionDeclarations: [{ name: "execute", description: mention }],
						},
					],
				},
			),
		);
		const parsed = JSON.parse(rewritten?.body ?? "{}");
		expect(parsed.contents[0].parts[0].text).toBe(mention);
		expect(parsed.contents[1].parts[0].text).toBe(mention);
		expect(parsed.tools[0].functionDeclarations[0].description).toBe(mention);
	});

	test("handles wrapped bodies, snake_case and a plain string instruction", () => {
		const wrapped = rewriteRefusedSystemText(
			JSON.stringify({
				project: "p",
				request: { systemInstruction: { parts: [{ text: HINT }] } },
			}),
		);
		expect(
			JSON.parse(wrapped?.body ?? "{}").request.systemInstruction.parts[0].text,
		).toContain('tools.opencode["session_move"]');

		const snake = rewriteRefusedSystemText(
			JSON.stringify({ system_instruction: { parts: [{ text: HINT }] } }),
		);
		expect(
			JSON.parse(snake?.body ?? "{}").system_instruction.parts[0].text,
		).toContain('tools.opencode["session_move"]');

		const plain = rewriteRefusedSystemText(body(HINT));
		expect(JSON.parse(plain?.body ?? "{}").systemInstruction).toContain(
			'tools.opencode["session_move"]',
		);
	});

	test("returns undefined when there is nothing to rewrite", () => {
		expect(rewriteRefusedSystemText("")).toBeUndefined();
		expect(rewriteRefusedSystemText("not json")).toBeUndefined();
		expect(rewriteRefusedSystemText("{}")).toBeUndefined();
		expect(
			rewriteRefusedSystemText(
				body({ parts: [{ text: "tools.opencode.models" }] }),
			),
		).toBeUndefined();
		expect(
			rewriteRefusedSystemText(
				JSON.stringify({
					contents: [
						{ role: "user", parts: [{ text: "tools.opencode.session_move" }] },
					],
				}),
			),
		).toBeUndefined();
	});
});
