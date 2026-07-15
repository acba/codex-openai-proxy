/*
 * Test implementation:
 * Validates OpenAI conversions and the compatibility fields sent to the Codex 0.144.1 backend
 * without reading local authentication or accessing external services.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildCodexRequestForModel, CODEX_CLIENT_VERSION } from "../dist/codex-client.js";
import { normalizeProxyError } from "../dist/errors.js";
import { validateStructuredOutput } from "../dist/schema.js";
import {
  buildCodexResponsesRequestFromChatCompletions,
  buildCodexResponsesRequestFromResponses,
  DEFAULT_MODEL,
} from "../dist/transform.js";

test("uses the Codex 0.144.1 defaults", () => {
  assert.equal(CODEX_CLIENT_VERSION, "0.144.1");
  assert.equal(DEFAULT_MODEL, "gpt-5.6-sol");
});

test("normalizes string Responses input and moves app instructions to a developer message", () => {
  const request = buildCodexResponsesRequestFromResponses({
    instructions: "Answer briefly.",
    input: "Hello",
  });

  assert.deepEqual(request.input, [
    {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "Answer briefly." }],
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Hello" }],
    },
  ]);
});

test("maps Chat Completions system and assistant messages to Codex Responses items", () => {
  const request = buildCodexResponsesRequestFromChatCompletions({
    messages: [
      { role: "system", content: "Be concise." },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
    ],
  });

  assert.equal(request.input[0].role, "developer");
  assert.equal(request.input[2].role, "assistant");
  assert.equal(request.input[2].content[0].type, "output_text");
});

test("uses catalog instructions and model capabilities in the upstream request", () => {
  const request = buildCodexResponsesRequestFromResponses({
    input: "Hello",
    reasoning: { effort: "xhigh" },
  });
  const prepared = buildCodexRequestForModel(request, {
    slug: "gpt-5.6-sol",
    base_instructions: "official model instructions",
    support_verbosity: true,
    default_verbosity: "low",
    supports_parallel_tool_calls: false,
    supported_reasoning_levels: [
      { effort: "high" },
      { effort: "xhigh" },
    ],
  });

  assert.equal(prepared.instructions, "official model instructions");
  assert.deepEqual(prepared.text, { verbosity: "low" });
  assert.equal(prepared.parallel_tool_calls, false);
  assert.deepEqual(prepared.reasoning, { effort: "xhigh" });
});

test("preserves Responses JSON Schema while applying model verbosity", () => {
  const format = {
    type: "json_schema",
    name: "result",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { value: { type: "string" } },
      required: ["value"],
    },
  };
  const request = buildCodexResponsesRequestFromResponses({
    input: "Return JSON.",
    text: { format },
  });
  const prepared = buildCodexRequestForModel(request, {
    slug: "gpt-5.6-luna",
    base_instructions: "official model instructions",
    support_verbosity: true,
    default_verbosity: "low",
  });

  assert.deepEqual(prepared.text, { format, verbosity: "low" });
});

test("preserves input_file and input_image content parts", () => {
  const request = buildCodexResponsesRequestFromResponses({
    input: [{
      type: "message",
      role: "user",
      content: [
        { type: "input_file", filename: "evidence.pdf", file_data: "data:application/pdf;base64,AA==" },
        { type: "input_image", image_url: "data:image/png;base64,AA==" },
        { type: "input_text", text: "Evaluate the attachments." },
      ],
    }],
  });

  assert.deepEqual(request.input[0].content, [
    { type: "input_file", filename: "evidence.pdf", file_data: "data:application/pdf;base64,AA==" },
    { type: "input_image", image_url: "data:image/png;base64,AA==" },
    { type: "input_text", text: "Evaluate the attachments." },
  ]);
});

test("validates strict structured model output", () => {
  const format = {
    type: "json_schema",
    name: "result",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: { type: "string", enum: ["completed"] },
        items: { type: "array", items: { type: "string" } },
      },
      required: ["status", "items"],
    },
  };

  assert.doesNotThrow(() => validateStructuredOutput('{"status":"completed","items":[]}', format));
  assert.throws(
    () => validateStructuredOutput('{"status":"completed","items":[],"extra":true}', format),
    (error) => error.code === "json_schema_validation_failed",
  );
  assert.throws(
    () => validateStructuredOutput("OK", format),
    (error) => error.code === "json_schema_validation_failed",
  );
});

test("normalizes upstream 429 errors without losing their status", () => {
  const error = normalizeProxyError(new Error("429 Too Many Requests"));
  assert.equal(error.status, 429);
  assert.equal(error.type, "rate_limit_error");
  assert.equal(error.code, "rate_limit_exceeded");
});

test("maps Chat Completions reasoning_effort to the Codex Responses payload", () => {
  const request = buildCodexResponsesRequestFromChatCompletions({
    reasoning_effort: "high",
    messages: [{ role: "user", content: "Hello" }],
  });

  assert.deepEqual(request.reasoning, { effort: "high" });
});

test("rejects reasoning levels that the selected model does not support", () => {
  const request = buildCodexResponsesRequestFromResponses({
    input: "Hello",
    reasoning: { effort: "none" },
  });

  assert.throws(
    () => buildCodexRequestForModel(request, {
      slug: "gpt-5.6-luna",
      base_instructions: "official model instructions",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
    }),
    /Supported values: low, high/,
  );
});
