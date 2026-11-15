import { describe, expect, test } from "bun:test";
import { repairToolSchemas } from "../src/tools.js";
import { prepareAntigravityRequest } from "../src/upstream.js";

const schema = {
	type: "object",
	properties: { path: { type: "string", description: "File path" } },
	required: ["path"],
};

/** The body opencode V2 sends: declarations carry `parametersJsonSchema`. */
const v2Body = (tools: unknown[]) =>
	JSON.stringify({
		contents: [{ role: "user", parts: [{ text: "hi" }] }],
		tools,
	});

describe("repairToolSchemas", () => {
	test("moves the JSON Schema of each declaration onto parameters", () => {
		const repaired = repairToolSchemas(
			v2Body([
				{
					functionDeclarations: [
						{ name: "read", description: "Read", parametersJsonSchema: schema },
					],
				},
			]),
		);
		expect(repaired?.repaired).toBe(1);
		const body = JSON.parse(repaired?.body ?? "{}");
		const declaration = body.tools[0].functionDeclarations[0];
		expect(declaration.parameters).toEqual(schema);
		expect(declaration.parametersJsonSchema).toBeUndefined();
		expect(declaration.name).toBe("read");
		expect(declaration.description).toBe("Read");
	});

	test("repairs every declaration of every tool", () => {
		const repaired = repairToolSchemas(
			v2Body([
				{
					functionDeclarations: [
						{ name: "a", parametersJsonSchema: schema },
						{ name: "b", parametersJsonSchema: schema },
					],
				},
				{ name: "c", description: "bare", parametersJsonSchema: schema },
			]),
		);
		expect(repaired?.repaired).toBe(3);
	});

	test("keeps other request fields untouched", () => {
		const repaired = repairToolSchemas(
			JSON.stringify({
				contents: [{ role: "user", parts: [{ text: "hi" }] }],
				generationConfig: { thinkingConfig: { thinkingLevel: "high" } },
				tools: [
					{
						functionDeclarations: [
							{ name: "read", parametersJsonSchema: schema },
						],
					},
				],
			}),
		);
		const body = JSON.parse(repaired?.body ?? "{}");
		expect(body.contents).toHaveLength(1);
		expect(body.generationConfig.thinkingConfig.thinkingLevel).toBe("high");
	});

	test("repairs a body that is already wrapped", () => {
		const repaired = repairToolSchemas(
			JSON.stringify({
				project: "p",
				model: "m",
				request: {
					tools: [
						{
							functionDeclarations: [
								{ name: "read", parametersJsonSchema: schema },
							],
						},
					],
				},
			}),
		);
		const body = JSON.parse(repaired?.body ?? "{}");
		expect(body.request.tools[0].functionDeclarations[0].parameters).toEqual(
			schema,
		);
	});

	test("leaves a declaration that already has parameters alone", () => {
		const existing = { type: "OBJECT", properties: { a: { type: "STRING" } } };
		expect(
			repairToolSchemas(
				v2Body([
					{
						functionDeclarations: [
							{
								name: "read",
								parameters: existing,
								parametersJsonSchema: schema,
							},
						],
					},
				]),
			),
		).toBeUndefined();
	});

	test("returns undefined when there is nothing to repair", () => {
		expect(repairToolSchemas("")).toBeUndefined();
		expect(repairToolSchemas("not json")).toBeUndefined();
		expect(repairToolSchemas("{}")).toBeUndefined();
		expect(repairToolSchemas(v2Body([]))).toBeUndefined();
		expect(repairToolSchemas(JSON.stringify({ tools: [{}] }))).toBeUndefined();
	});
});

describe("repairToolSchemas with the real request preparation", () => {
	test("gives the model the arguments its tools declare", async () => {
		const body = v2Body([
			{
				functionDeclarations: [
					{
						name: "read",
						description: "Read a file",
						parametersJsonSchema: schema,
					},
				],
			},
		]);
		const broken = prepareAntigravityRequest(
			"https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.8-flash-tiered:streamGenerateContent",
			{ method: "POST", body },
			"token",
			"project",
			"https://daily-cloudcode-pa.sandbox.googleapis.com",
			"antigravity",
		);
		// The failure this module exists for: a declaration with no schema.
		expect(broken.toolDebugPayload).toContain('"properties":{}');

		const repaired = repairToolSchemas(body);
		const prepared = prepareAntigravityRequest(
			"https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.8-flash-tiered:streamGenerateContent",
			{ method: "POST", body: repaired?.body },
			"token",
			"project",
			"https://daily-cloudcode-pa.sandbox.googleapis.com",
			"antigravity",
		);
		const tools = JSON.parse(prepared.toolDebugPayload ?? "[]");
		const declaration = tools[0].functionDeclarations[0];
		expect(declaration.name).toBe("read");
		expect(declaration.parameters.properties.path).toMatchObject({
			type: "string",
			description: "File path",
		});
		expect(declaration.parameters.required).toEqual(["path"]);
	});

	test("flattens schema features the Antigravity proto rejects", () => {
		const repaired = repairToolSchemas(
			v2Body([
				{
					functionDeclarations: [
						{
							name: "write",
							parametersJsonSchema: {
								type: "object",
								properties: {
									mode: { const: "append" },
									target: { type: ["string", "null"] },
								},
								additionalProperties: false,
								$defs: { unused: { type: "boolean" } },
							},
						},
					],
				},
			]),
		);
		const body = JSON.parse(repaired?.body ?? "{}");
		const parameters = body.tools[0].functionDeclarations[0].parameters;
		expect(parameters.properties.mode.enum).toEqual(["append"]);
		expect(parameters.properties.target.type).toBe("string");
		expect(parameters.additionalProperties).toBeUndefined();
		expect(parameters.$defs).toBeUndefined();
	});
});
