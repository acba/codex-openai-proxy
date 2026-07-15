/*
 * Implementation notes:
 * Validates the strict JSON Schema subset used by Responses Structured Outputs. The validator is
 * intentionally dependency-free and rejects unsupported schema keywords instead of pretending
 * that an output was validated.
 */

import { OpenAIProxyError } from "./errors.js";
import type { OpenAIJsonSchema, OpenAITextFormat } from "./types.js";

const SUPPORTED_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "description",
  "title",
]);

function schemaError(message: string) {
  return new OpenAIProxyError({
    status: 400,
    type: "invalid_request_error",
    code: "unsupported_json_schema",
    message,
  });
}

function outputError(message: string) {
  return new OpenAIProxyError({
    status: 502,
    type: "invalid_model_output",
    code: "json_schema_validation_failed",
    message,
  });
}

function validateSupportedSchema(schema: OpenAIJsonSchema, path = "$") {
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      throw schemaError(`Unsupported JSON Schema keyword at ${path}: ${keyword}`);
    }
  }
  if (schema.properties) {
    for (const [key, child] of Object.entries(schema.properties)) {
      validateSupportedSchema(child, `${path}.properties.${key}`);
    }
  }
  if (schema.items) validateSupportedSchema(schema.items, `${path}.items`);
}

function actualType(value: unknown) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function typeMatches(value: unknown, expected: string) {
  if (expected === "object") return typeof value === "object" && value !== null && !Array.isArray(value);
  if (expected === "array") return Array.isArray(value);
  if (expected === "integer") return typeof value === "number" && Number.isInteger(value);
  if (expected === "number") return typeof value === "number";
  if (expected === "null") return value === null;
  return typeof value === expected;
}

function validateValue(value: unknown, schema: OpenAIJsonSchema, path = "$") {
  if (schema.enum && !schema.enum.some((allowed) => Object.is(allowed, value))) {
    throw outputError(`Model output at ${path} is not one of the allowed enum values`);
  }
  if (schema.type && !typeMatches(value, schema.type)) {
    throw outputError(
      `Model output at ${path} must be ${schema.type}, received ${actualType(value)}`,
    );
  }
  if (schema.type === "object") {
    const object = value as Record<string, unknown>;
    for (const required of schema.required ?? []) {
      if (!(required in object)) throw outputError(`Model output is missing required field ${path}.${required}`);
    }
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      const extras = Object.keys(object).filter((key) => !(key in properties));
      if (extras.length > 0) {
        throw outputError(`Model output contains additional fields at ${path}: ${extras.join(", ")}`);
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (key in object) validateValue(object[key], child, `${path}.${key}`);
    }
  }
  if (schema.type === "array" && schema.items) {
    (value as unknown[]).forEach((item, index) => validateValue(item, schema.items!, `${path}[${index}]`));
  }
}

export function jsonSchemaFromFormat(format?: OpenAITextFormat) {
  if (format?.type !== "json_schema") return undefined;
  if (!format.name?.trim()) throw schemaError("JSON Schema format requires a non-empty name");
  if (!format.schema || typeof format.schema !== "object" || Array.isArray(format.schema)) {
    throw schemaError("JSON Schema format requires a schema object");
  }
  validateSupportedSchema(format.schema);
  return format.schema;
}

export function validateStructuredOutput(text: string, format?: OpenAITextFormat) {
  const schema = jsonSchemaFromFormat(format);
  if (!schema) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw outputError("Model output is not valid JSON for the requested Structured Output");
  }
  validateValue(parsed, schema);
}
