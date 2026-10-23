/*
 * Test implementation:
 * Validates OpenAI conversions and the compatibility fields sent to the Codex backend
 * without reading local authentication or accessing external services.
 */

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCodexRequestForModel, configureCodexClient, fetchCodexModels, getCodexClientVersion } from "../dist/codex-client.js";
import { detectCodexVersion } from "../dist/codex-version.js";
import { normalizeProxyError } from "../dist/errors.js";
import { createProxyServer, DEFAULT_BODY_LIMIT_BYTES } from "../dist/index.js";
import { validateStructuredOutput } from "../dist/schema.js";
import {
  buildCodexResponsesRequestFromChatCompletions,
  buildCodexResponsesRequestFromResponses,
  DEFAULT_MODEL,
} from "../dist/transform.js";

test("preserves the default model", () => {
  assert.equal(DEFAULT_MODEL, "gpt-5.6-sol");
});

test("accepts a 12 MiB Responses JSON body for Base64 file inputs", async () => {
  assert.equal(DEFAULT_BODY_LIMIT_BYTES, 75 * 1024 * 1024);
  const app = await createProxyServer({ logger: false });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { "content-type": "application/json" },
      payload: {
        model: "gpt-5.6-luna",
        input: [{
          type: "message",
          role: "user",
          content: [{ type: "unsupported_test_part", text: "x".repeat(12 * 1024 * 1024) }],
        }],
      },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, "unsupported_content_type");
  } finally {
    await app.close();
  }
});

test("detects stable and prerelease versions without invoking a shell", (t) => {
  let output = "codex-cli 0.162.1\n";
  t.mock.method(childProcess, "execFileSync", (command, args, options) => {
    assert.equal(command, "codex");
    assert.deepEqual(args, ["--version"]);
    assert.equal(options.shell, undefined);
    assert.equal(options.timeout, 5000);
    return output;
  });
  assert.equal(detectCodexVersion(), "0.162.1");
  output = "codex-cli 0.163.0-alpha.1\r\n";
  assert.equal(detectCodexVersion(), "0.163.0-alpha.1");
  output = "unexpected output";
  assert.throws(() => detectCodexVersion(), /Unrecognized codex --version output/);
});

test("fails clearly when Codex is missing or version detection times out", (t) => {
  let code = "ENOENT";
  t.mock.method(childProcess, "execFileSync", () => {
    throw Object.assign(new Error("private subprocess output"), { code });
  });
  for (code of ["ENOENT", "ETIMEDOUT"]) {
    assert.throws(() => detectCodexVersion(), (error) => {
      assert.match(error.message, /Ensure codex is available on PATH/);
      assert.doesNotMatch(error.message, /private subprocess output/);
      return true;
    });
  }
});

test("uses the detected version in catalog requests and refreshes it on configuration", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-proxy-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const authFilePath = path.join(directory, "auth.json");
  fs.writeFileSync(authFilePath, JSON.stringify({tokens:{access_token:"test-token",account_id:"test-account"}}));
  let version = "0.162.1";
  let detections = 0;
  let requests = 0;
  t.mock.method(childProcess, "execFileSync", () => {
    detections++;
    return `codex-cli ${version}\n`;
  });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests++;
    assert.equal(new URL(url).searchParams.get("client_version"), version);
    assert.equal(options.headers.version, version);
    assert.ok(options.headers["User-Agent"].startsWith(`codex_cli_rs/${version} `));
    return new Response(JSON.stringify({models:[{slug:"gpt-6-luna"}]}));
  });
  configureCodexClient({authFilePath});
  assert.equal(getCodexClientVersion(), version);
  await fetchCodexModels();
  await fetchCodexModels();
  assert.equal(detections, 1);
  assert.equal(requests, 1);
  version = "0.163.0";
  configureCodexClient({authFilePath});
  await fetchCodexModels();
  assert.equal(detections, 2);
  assert.equal(requests, 2);
});

async function createCatalogTestServer(t, upstreamResponse) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-proxy-catalog-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const authFilePath = path.join(directory, "auth.json");
  fs.writeFileSync(authFilePath, JSON.stringify({
    tokens: { access_token: "test-token", account_id: "test-account" },
  }));
  t.mock.method(childProcess, "execFileSync", () => "codex-cli 0.162.1\n");
  t.mock.method(globalThis, "fetch", upstreamResponse);
  configureCodexClient({ authFilePath });
  const app = await createProxyServer({ logger: false });
  t.after(() => app.close());
  return app;
}

test("lists reasoning capabilities from the same filtered, sorted model catalog", async (t) => {
  let requests = 0;
  const app = await createCatalogTestServer(t, async () => {
    requests++;
    return new Response(JSON.stringify({ models: [
      { slug: "no-metadata", priority: 2, base_instructions: "private instructions" },
      {
        slug: "reasoner", priority: 1, default_reasoning_level: "high",
        supported_reasoning_levels: [{ effort: "low", description: "Fast" }, { effort: "high" }],
      },
      { slug: "hidden", visibility: "hide" },
      { slug: "not-api", supported_in_api: false },
    ] }));
  });
  const response = await app.inject("/v1/models/reasoning");
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { object: "list", data: [
    {
      id: "reasoner", object: "model_reasoning", default_reasoning_level: "high",
      supported_reasoning_levels: [{ effort: "low", description: "Fast" }, { effort: "high" }],
    },
    {
      id: "no-metadata", object: "model_reasoning", default_reasoning_level: null,
      supported_reasoning_levels: [],
    },
  ] });
  const models = await app.inject("/v1/models");
  assert.deepEqual(models.json(), { object: "list", data: ["reasoner", "no-metadata"].map((id) => ({
    id, object: "model", created: 0, owned_by: "chatgpt-codex",
  })) });
  const single = await app.inject("/v1/models/reasoner/reasoning");
  assert.equal(single.statusCode, 200);
  assert.deepEqual(single.json(), response.json().data[0]);
  assert.equal(requests, 1);
  const root = await app.inject("/");
  assert.equal(root.json().endpoints.modelReasoning, "http://localhost:80/v1/models/reasoning");
  for (const model of ["missing", "hidden", "not-api"]) {
    const missing = await app.inject(`/v1/models/${model}/reasoning`);
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.type, "invalid_request_error");
    assert.equal(missing.json().error.code, "model_not_found");
  }
});

test("returns an empty reasoning list when the catalog has no models", async (t) => {
  const app = await createCatalogTestServer(t, async () => new Response("{}"));
  const response = await app.inject("/v1/models/reasoning");
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { object: "list", data: [] });
});

test("reasoning endpoints preserve catalog authentication and rate-limit errors", async (t) => {
  for (const status of [401, 429]) {
    await t.test(String(status), async (t) => {
      const app = await createCatalogTestServer(t, async () => new Response("Unavailable", { status }));
      for (const url of ["/v1/models/reasoning", "/v1/models/reasoner/reasoning"]) {
        const response = await app.inject(url);
        assert.equal(response.statusCode, status);
        assert.equal(response.json().error.type, status === 401 ? "authentication_error" : "rate_limit_error");
        assert.equal(response.json().error.code, status === 401 ? "model_catalog_unavailable" : "rate_limit_exceeded");
      }
    });
  }
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
        { type: "input_file", filename: "evidence.pdf", file_data: "data:application/pdf;base64,AA==", detail: "auto" },
        { type: "input_image", image_url: "data:image/png;base64,AA==" },
        { type: "input_text", text: "Evaluate the attachments." },
      ],
    }],
  });

  assert.deepEqual(request.input[0].content, [
    { type: "input_file", filename: "evidence.pdf", file_data: "data:application/pdf;base64,AA==", detail: "auto" },
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
