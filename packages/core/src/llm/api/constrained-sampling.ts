// Vendored from @earendil-works/pi-ai (0.99.2). @ts-nocheck keeps the repo root's stricter config
// from flagging this file, while every import into packages/core stays fully checked.
// @ts-nocheck
import type { Tool } from "../types.ts";

interface JsonSchemaObject {
	[key: string]: unknown;
	type?: unknown;
	properties?: Record<string, JsonSchemaObject | undefined>;
	required?: unknown;
}

class UnsupportedStrictJsonSchemaError extends Error {}

/** Returns true when a provider's strict mode rejects this schema keyword with this value. */
export type UnsupportedStrictSchemaKeywordCheck = (key: string, value: unknown) => boolean;

const UNSUPPORTED_STRICT_SCHEMA_KEYS = [
	"$ref",
	"$defs",
	"definitions",
	"allOf",
	"oneOf",
	"patternProperties",
	"dependentSchemas",
	"dependencies",
	"unevaluatedProperties",
	"propertyNames",
	"contains",
	"prefixItems",
	"not",
	"if",
	"then",
	"else",
] as const;

function isJsonSchemaObject(value: unknown): value is JsonSchemaObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStructuredSchema(schema: unknown): boolean {
	if (!isJsonSchemaObject(schema)) return false;
	const types = typeof schema.type === "string" ? [schema.type] : Array.isArray(schema.type) ? schema.type : [];
	return (
		types.includes("object") ||
		types.includes("array") ||
		schema.properties !== undefined ||
		schema.items !== undefined
	);
}

function schemaAllowsNull(schema: unknown): boolean {
	if (!isJsonSchemaObject(schema)) return false;
	if (schema.type === "null" || (Array.isArray(schema.type) && schema.type.includes("null"))) return true;
	if (schema.const === null || (Array.isArray(schema.enum) && schema.enum.includes(null))) return true;
	return Array.isArray(schema.anyOf) && schema.anyOf.some((variant) => schemaAllowsNull(variant));
}

function makeJsonSchemaNodeStrict(schema: unknown, isUnsupportedKeyword?: UnsupportedStrictSchemaKeywordCheck): void {
	if (!isJsonSchemaObject(schema)) {
		throw new UnsupportedStrictJsonSchemaError("boolean schemas are unsupported");
	}
	for (const key of UNSUPPORTED_STRICT_SCHEMA_KEYS) {
		if (schema[key] !== undefined) {
			throw new UnsupportedStrictJsonSchemaError(`${key} schemas are unsupported`);
		}
	}
	if (isUnsupportedKeyword) {
		for (const [key, value] of Object.entries(schema)) {
			if (isUnsupportedKeyword(key, value)) {
				throw new UnsupportedStrictJsonSchemaError(`${key}: ${JSON.stringify(value)} is unsupported`);
			}
		}
	}

	if (schema.anyOf !== undefined) {
		if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) {
			throw new UnsupportedStrictJsonSchemaError("anyOf must contain at least one schema");
		}
		for (const variant of schema.anyOf) {
			if (isStructuredSchema(variant)) {
				throw new UnsupportedStrictJsonSchemaError("object and array unions are unsupported");
			}
			makeJsonSchemaNodeStrict(variant, isUnsupportedKeyword);
		}
	}

	if (schema.items !== undefined) {
		if (Array.isArray(schema.items)) {
			throw new UnsupportedStrictJsonSchemaError("tuple schemas are unsupported");
		}
		makeJsonSchemaNodeStrict(schema.items, isUnsupportedKeyword);
	}

	const isObjectSchema = schema.type === "object";
	if (schema.properties !== undefined && !isObjectSchema) {
		throw new UnsupportedStrictJsonSchemaError("properties require type object");
	}
	if (!isObjectSchema) return;
	if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
		throw new UnsupportedStrictJsonSchemaError("schema-valued or true additionalProperties is unsupported");
	}
	if (schema.properties !== undefined && !isJsonSchemaObject(schema.properties)) {
		throw new UnsupportedStrictJsonSchemaError("object properties must be a schema map");
	}
	if (
		schema.required !== undefined &&
		(!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string"))
	) {
		throw new UnsupportedStrictJsonSchemaError("object required must be a string array");
	}

	const properties = schema.properties ?? {};
	const propertyNames = Object.keys(properties);
	const required = new Set(Array.isArray(schema.required) ? schema.required : []);
	if ([...required].some((key) => !propertyNames.includes(key))) {
		throw new UnsupportedStrictJsonSchemaError("required contains an unknown property");
	}
	for (const [key, property] of Object.entries(properties)) {
		makeJsonSchemaNodeStrict(property, isUnsupportedKeyword);
		if (!required.has(key) && !schemaAllowsNull(property)) {
			properties[key] = { anyOf: [property, { type: "null" }] };
		}
	}
	schema.required = propertyNames;
	schema.additionalProperties = false;
}

/** Convert a tool schema to the strict subset expected by provider constrained sampling. */
export function makeStrictJsonSchema(
	schema: Tool["parameters"],
	isUnsupportedKeyword?: UnsupportedStrictSchemaKeywordCheck,
): Record<string, unknown> {
	const cloned: unknown = structuredClone(schema);
	if (!isJsonSchemaObject(cloned)) {
		throw new UnsupportedStrictJsonSchemaError("root schema must have type object");
	}
	makeJsonSchemaNodeStrict(cloned, isUnsupportedKeyword);
	if (cloned.type !== "object") {
		throw new UnsupportedStrictJsonSchemaError("root schema must have type object");
	}
	return cloned;
}

export function getJsonSchemaToolParameters(tool: Tool, strict: boolean | undefined): Tool["parameters"] {
	return (strict === true ? makeStrictJsonSchema(tool.parameters) : tool.parameters) as Tool["parameters"];
}

/**
 * Decide whether a JSON-schema tool is sent in strict mode. `isUnsupportedKeyword` lets a provider
 * reject extra keywords its strict mode does not accept, so "prefer" tools fall back to non-strict.
 */
export function resolveJsonSchemaStrictSampling(
	tool: Tool,
	supportsStrictMode: boolean,
	isUnsupportedKeyword?: UnsupportedStrictSchemaKeywordCheck,
): boolean | undefined {
	const config = tool.constrainedSampling;
	if (!config || config.type !== "json_schema") return undefined;

	if (supportsStrictMode) {
		try {
			makeStrictJsonSchema(tool.parameters, isUnsupportedKeyword);
			return true;
		} catch (error) {
			if (!(error instanceof UnsupportedStrictJsonSchemaError)) throw error;
			if (config.strict !== "require") return undefined;
			throw new Error(`Tool "${tool.name}" requires JSON-schema constrained sampling, but ${error.message}.`);
		}
	}
	if (config.strict === "require") {
		throw new Error(
			`Tool "${tool.name}" requires JSON-schema constrained sampling, but strict tools are unsupported.`,
		);
	}
	return undefined;
}
