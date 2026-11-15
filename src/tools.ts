/**
 * Tool schema compatibility with opencode V2.
 *
 * V2 speaks the Gemini protocol with `parametersJsonSchema`, the field
 * Google's API documents for a full JSON Schema:
 *
 * ```json
 * {"tools":[{"functionDeclarations":[
 *   {"name":"read","description":"…","parametersJsonSchema":{…}}]}]}
 * ```
 *
 * The upstream transform only reads `parameters` (the OpenAPI-subset field
 * V1's SDK used), so a V2 request looks like a declaration with no schema at
 * all: preparation replaces it with `{type:"OBJECT",properties:{}}` and the
 * model receives every tool without arguments — it calls `read` with `{}` and
 * the turn cannot go anywhere. Moving the schema onto `parameters` and
 * cleaning it for the Antigravity proto before preparation fixes both.
 */
import { cleanJSONSchemaForAntigravity } from "./upstream.js";

type JsonObject = Record<string, unknown>;

/** Full JSON Schema field opencode V2 sends. */
const JSON_SCHEMA_FIELD = "parametersJsonSchema";

/** OpenAPI-subset field the upstream transform understands. */
const SCHEMA_FIELD = "parameters";

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Moves the JSON Schema onto `parameters` on one declaration, cleaned for the
 * Antigravity proto. A declaration that already carries `parameters` is left
 * alone: that field is the one the backend consumes, so it wins.
 */
function adoptJsonSchema(declaration: JsonObject): boolean {
	if (isObject(declaration[SCHEMA_FIELD])) return false;
	const schema = declaration[JSON_SCHEMA_FIELD];
	if (!isObject(schema)) return false;
	declaration[SCHEMA_FIELD] = cleanJSONSchemaForAntigravity(schema);
	delete declaration[JSON_SCHEMA_FIELD];
	return true;
}

/** The generative payload of a body, wrapped (`{ request }`) or direct. */
function payloadOf(body: JsonObject): JsonObject {
	return isObject(body.request) ? body.request : body;
}

/**
 * Repairs the tool declarations of a request body.
 *
 * Returns the serialized body and how many declarations were rewritten, or
 * undefined when there is nothing to repair. Bodies that are not JSON, or that
 * carry no tools, are the caller's to send as they are.
 */
export function repairToolSchemas(
	body: string,
): { body: string; repaired: number } | undefined {
	if (body.length === 0) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return undefined;
	}
	if (!isObject(parsed)) return undefined;
	const payload = payloadOf(parsed);
	if (!Array.isArray(payload.tools)) return undefined;

	let repaired = 0;
	for (const tool of payload.tools) {
		if (!isObject(tool)) continue;
		const declarations = tool.functionDeclarations;
		if (Array.isArray(declarations)) {
			for (const declaration of declarations) {
				if (isObject(declaration) && adoptJsonSchema(declaration))
					repaired += 1;
			}
			continue;
		}
		// A tool sent as a bare declaration: { name, description, schema }.
		if (adoptJsonSchema(tool)) repaired += 1;
	}

	if (repaired === 0) return undefined;
	return { body: JSON.stringify(parsed), repaired };
}
