/*
 * Implementation notes:
 * Implements the Codex CLI 0.144.1 protocol for chatgpt.com/backend-api/codex/*. It caches the
 * model catalog and base instructions, opens an authenticated Responses WebSocket, and exposes
 * upstream results as either event arrays or incremental callbacks.
 */

import crypto from "node:crypto";
import os from "node:os";

import type { FastifyReply } from "fastify";
import WebSocket, { type RawData } from "ws";

import { readCodexAuth } from "./auth.js";
import { normalizeProxyError, OpenAIProxyError } from "./errors.js";
import type { CodexEvent, CodexModelEntry, CodexResponsesRequest } from "./types.js";

const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
export const CODEX_CLIENT_VERSION = "0.144.1";
const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";
const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 15_000;
const MODELS_TIMEOUT_MS = 30_000;
let configuredAuthFilePath: string | undefined;
let modelsCache: { expiresAt: number; value: { models?: CodexModelEntry[] } } | undefined;

function createRequestId() {
  return crypto.randomUUID();
}

export function configureCodexClient(options: { authFilePath?: string }) {
  configuredAuthFilePath = options.authFilePath;
  modelsCache = undefined;
}

function buildBaseHeaders() {
  const auth = readCodexAuth(configuredAuthFilePath);

  return {
    Authorization: `Bearer ${auth.accessToken}`,
    "ChatGPT-Account-ID": auth.accountId,
    originator: "codex_cli_rs",
    version: CODEX_CLIENT_VERSION,
    "User-Agent": `codex_cli_rs/${CODEX_CLIENT_VERSION} (${process.platform} ${os.release()}; ${process.arch}) codex-openai-proxy`,
  };
}

export async function fetchCodexModels(options: { force?: boolean } = {}) {
  if (!options.force && modelsCache && modelsCache.expiresAt > Date.now()) {
    return modelsCache.value;
  }

  const response = await fetch(
    `${CODEX_BASE_URL}/codex/models?client_version=${CODEX_CLIENT_VERSION}`,
    {
      headers: buildBaseHeaders(),
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    throw new OpenAIProxyError({
      status: response.status,
      type: response.status === 401 || response.status === 403
        ? "authentication_error"
        : response.status === 429
          ? "rate_limit_error"
          : "upstream_error",
      code: response.status === 429 ? "rate_limit_exceeded" : "model_catalog_unavailable",
      message: `Failed to fetch the Codex model list: ${response.status} ${await response.text()}`,
    });
  }

  const value = (await response.json()) as { models?: CodexModelEntry[] };
  modelsCache = { expiresAt: Date.now() + MODELS_CACHE_TTL_MS, value };
  return value;
}

export function buildCodexRequestForModel(
  body: CodexResponsesRequest,
  model: CodexModelEntry,
): CodexResponsesRequest {
  if (!model.base_instructions) {
    throw new OpenAIProxyError({
      status: 502,
      type: "upstream_error",
      code: "model_catalog_invalid",
      message: `The Codex catalog did not provide base instructions for model: ${model.slug}`,
    });
  }

  const requestedEffort = body.reasoning?.effort;
  const supportedEfforts = model.supported_reasoning_levels?.map((level) => level.effort) ?? [];
  if (requestedEffort && !supportedEfforts.some((effort) => effort === requestedEffort)) {
    const supported = supportedEfforts.length > 0 ? supportedEfforts.join(", ") : "none";
    throw new OpenAIProxyError({
      status: 400,
      type: "invalid_request_error",
      code: "unsupported_reasoning_effort",
      message: `Reasoning effort '${requestedEffort}' is not supported by ${model.slug}. Supported values: ${supported}`,
    });
  }

  const defaultVerbosity = model.support_verbosity && !body.text?.verbosity
    ? { verbosity: model.default_verbosity ?? "medium" }
    : {};
  const text = body.text || Object.keys(defaultVerbosity).length > 0
    ? { ...body.text, ...defaultVerbosity }
    : undefined;

  return {
    ...body,
    model: model.slug,
    instructions: model.base_instructions,
    parallel_tool_calls: model.supports_parallel_tool_calls ?? body.parallel_tool_calls,
    text,
  };
}

export async function prepareCodexRequest(body: CodexResponsesRequest) {
  const catalog = await fetchCodexModels();
  const model = catalog.models?.find((candidate) => candidate.slug === body.model);

  if (!model || model.visibility === "hide" || model.supported_in_api === false) {
    throw new OpenAIProxyError({
      status: 400,
      type: "invalid_request_error",
      code: "model_not_found",
      message: `Model unavailable in Codex ${CODEX_CLIENT_VERSION}: ${body.model}`,
    });
  }

  return buildCodexRequestForModel(body, model);
}

function buildWebSocketHeaders(requestId: string) {
  return {
    ...buildBaseHeaders(),
    "OpenAI-Beta": OPENAI_BETA_RESPONSES_WEBSOCKETS,
    "x-client-request-id": requestId,
    "session-id": requestId,
    "thread-id": requestId,
  };
}

function parseWebSocketEvent(data: RawData) {
  return JSON.parse(data.toString("utf8")) as CodexEvent;
}

function getResponseError(event: CodexEvent) {
  if (event.type === "error") {
    const message = event.error?.message ?? "The Codex backend returned an error";
    const normalized = normalizeProxyError(new Error(`${event.status ?? ""} ${message}`.trim()));
    const retryAfter = event.error?.retry_after_seconds ?? event.retry_after_seconds;
    if (retryAfter === undefined) return normalized;
    return new OpenAIProxyError({
      status: normalized.status,
      type: normalized.type,
      code: normalized.code,
      message: normalized.message,
      retryAfter,
    });
  }

  if (event.type === "response.failed") {
    const response = event.response as { error?: { message?: string; code?: string } } | undefined;
    const message = response?.error?.message ?? "The Codex response failed";
    return normalizeProxyError(new Error(`${response?.error?.code ?? ""} ${message}`.trim()));
  }

  if (event.type === "response.incomplete") {
    const response = event.response as { incomplete_details?: { reason?: string } } | undefined;
    return new OpenAIProxyError({
      status: 502,
      type: "upstream_error",
      code: "response_incomplete",
      message: `The Codex response was incomplete${response?.incomplete_details?.reason ? `: ${response.incomplete_details.reason}` : ""}`,
    });
  }

  return undefined;
}

export async function collectCodexResponseEvents(
  body: CodexResponsesRequest,
  options: { prepared?: boolean } = {},
) {
  const requestId = createRequestId();
  const preparedBody = options.prepared ? body : await prepareCodexRequest(body);
  const ws = new WebSocket(`${CODEX_BASE_URL.replace("https://", "wss://")}/codex/responses`, {
    headers: buildWebSocketHeaders(requestId),
    handshakeTimeout: CONNECT_TIMEOUT_MS,
  });

  const events: CodexEvent[] = [];

  return await new Promise<CodexEvent[]>((resolve, reject) => {
    let completed = false;

    const close = () => {
      try {
        ws.close();
      } catch {
        // ignore
      }
    };

    ws.once("open", () => {
      ws.send(JSON.stringify({
        type: "response.create",
        ...preparedBody,
        prompt_cache_key: preparedBody.prompt_cache_key ?? requestId,
      }));
    });

    ws.on("message", (data) => {
      let parsed: CodexEvent;
      try {
        parsed = parseWebSocketEvent(data);
      } catch (error) {
        completed = true;
        close();
        reject(error);
        return;
      }
      events.push(parsed);

      const responseError = getResponseError(parsed);
      if (responseError) {
        completed = true;
        close();
        reject(responseError);
        return;
      }

      if (parsed.type === "response.completed") {
        completed = true;
        close();
        resolve(events);
      }
    });

    ws.once("error", (error) => {
      if (!completed) {
        completed = true;
        reject(new Error(`Codex WebSocket connection failed: ${error.message}`));
      }
    });

    ws.once("close", (code, reason) => {
      if (!completed) {
        completed = true;
        reject(new Error(`Codex WebSocket closed before completion (${code}): ${reason}`));
      }
    });
  });
}

export async function streamCodexResponseToSSE(
  body: CodexResponsesRequest,
  reply: FastifyReply,
  onEvent: (event: CodexEvent) => void,
  options: { prepared?: boolean } = {},
) {
  const requestId = createRequestId();
  const preparedBody = options.prepared ? body : await prepareCodexRequest(body);
  const ws = new WebSocket(`${CODEX_BASE_URL.replace("https://", "wss://")}/codex/responses`, {
    headers: buildWebSocketHeaders(requestId),
    handshakeTimeout: CONNECT_TIMEOUT_MS,
  });

  return await new Promise<void>((resolve, reject) => {
    let done = false;

    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      try {
        ws.close();
      } catch {
        // ignore
      }
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    ws.once("open", () => {
      ws.send(JSON.stringify({
        type: "response.create",
        ...preparedBody,
        prompt_cache_key: preparedBody.prompt_cache_key ?? requestId,
      }));
    });

    ws.on("message", (data) => {
      let parsed: CodexEvent;
      try {
        parsed = parseWebSocketEvent(data);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      onEvent(parsed);

      const responseError = getResponseError(parsed);
      if (responseError) {
        finish(responseError);
        return;
      }

      if (parsed.type === "response.completed") {
        finish();
      }
    });

    ws.once("error", (error) => {
      finish(new Error(`Codex WebSocket connection failed: ${error.message}`));
    });

    ws.once("close", (code, reason) => {
      if (!done) {
        finish(new Error(`Codex WebSocket closed before completion (${code}): ${reason}`));
      }
    });

    reply.raw.on("close", () => {
      if (!done) {
        finish();
      }
    });
  });
}
