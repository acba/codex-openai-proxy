/*
 * Implementation notes:
 * Provides the public OpenAI-compatible HTTP routes and root information endpoint:
 * - /
 * - /health
 * - /v1/models
 * - /v1/models/reasoning and /v1/models/:model/reasoning (proxy extensions)
 * - /v1/responses
 * - /v1/chat/completions
 * Requests are normalized, proxied to the Codex backend API, and mapped to standard responses.
 */

import type { FastifyInstance, FastifyReply } from "fastify";

import {
  collectCodexResponseEvents,
  fetchCodexModels,
  prepareCodexRequest,
  streamCodexResponseToSSE,
} from "./codex-client.js";
import { normalizeProxyError, openAIErrorBody, OpenAIProxyError } from "./errors.js";
import { jsonSchemaFromFormat, validateStructuredOutput } from "./schema.js";
import {
  buildCodexResponsesRequestFromChatCompletions,
  buildCodexResponsesRequestFromResponses,
  collectTextFromCodexEvents,
  createChatCompletion,
  createChatCompletionChunk,
  createChatCompletionDoneChunk,
  createOpenAIResponsesOutput,
  normalizeModelName,
} from "./transform.js";
import type { CodexEvent, CodexModelEntry, OpenAIChatCompletionsRequest, OpenAIResponsesRequest } from "./types.js";

async function availableModels() {
  const result = await fetchCodexModels();
  return (result.models ?? [])
    .filter((model) => model.visibility !== "hide" && model.supported_in_api !== false)
    .sort((left, right) => (left.priority ?? 0) - (right.priority ?? 0));
}

function modelReasoning(model: CodexModelEntry) {
  return {
    id: model.slug,
    object: "model_reasoning",
    default_reasoning_level: model.default_reasoning_level ?? null,
    supported_reasoning_levels: (model.supported_reasoning_levels ?? []).map((level) => ({
      effort: level.effort,
      ...(level.description !== undefined ? { description: level.description } : {}),
    })),
  };
}

function writeSSE(reply: FastifyReply, data: unknown) {
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

function logIgnoredParameters(
  logger: FastifyInstance["log"] | FastifyReply["log"],
  body: Record<string, unknown>,
  allowedKeys: string[],
) {
  const ignoredKeys = Object.keys(body).filter((key) => !allowedKeys.includes(key));

  if (ignoredKeys.length > 0) {
    logger.warn(`Ignoring unsupported OpenAI parameters: ${ignoredKeys.join(", ")}`);
  }
}

function writeSSEError(reply: FastifyReply, error: unknown) {
  const normalized = normalizeProxyError(error);
  writeSSE(reply, {
    type: "error",
    status: normalized.status,
    ...openAIErrorBody(normalized),
  });
}

export async function registerRoutes(app: FastifyInstance) {
  app.setErrorHandler((error, _request, reply) => {
    const normalized = normalizeProxyError(error);
    if (normalized.retryAfter !== undefined) {
      reply.header("Retry-After", String(normalized.retryAfter));
    }
    reply.status(normalized.status).send(openAIErrorBody(normalized));
  });

  app.get("/", async (request) => {
    const host = request.headers.host ?? "127.0.0.1:8787";
    const baseUrl = `${request.protocol}://${host}`;

    return {
      name: "codex-openai-proxy",
      message: "This service exposes local Codex authentication through an OpenAI-compatible API.",
      endpoints: {
        health: `${baseUrl}/health`,
        models: `${baseUrl}/v1/models`,
        modelReasoning: `${baseUrl}/v1/models/reasoning`,
        responses: `${baseUrl}/v1/responses`,
        chatCompletions: `${baseUrl}/v1/chat/completions`,
      },
      openai: {
        baseURL: `${baseUrl}/v1`,
        apiKey: "dummy",
      },
    };
  });

  app.get("/health", async () => ({ ok: true }));

  app.get("/v1/models", async () => {
    const items = (await availableModels()).map((model) => ({
      id: model.slug,
      object: "model",
      created: 0,
      owned_by: "chatgpt-codex",
    }));

    return {
      object: "list",
      data: items,
    };
  });

  app.get("/v1/models/reasoning", async () => ({
    object: "list",
    data: (await availableModels()).map(modelReasoning),
  }));

  app.get<{ Params: { model: string } }>("/v1/models/:model/reasoning", async (request) => {
    const model = (await availableModels()).find((entry) => entry.slug === request.params.model);
    if (!model) {
      throw new OpenAIProxyError({
        status: 404,
        type: "invalid_request_error",
        code: "model_not_found",
        message: `Model unavailable: ${request.params.model}`,
      });
    }
    return modelReasoning(model);
  });

  app.post<{ Body: OpenAIResponsesRequest }>("/v1/responses", async (request, reply) => {
    logIgnoredParameters(
      request.log,
      (request.body ?? {}) as Record<string, unknown>,
      ["model", "instructions", "input", "stream", "reasoning", "text"],
    );

    const body = buildCodexResponsesRequestFromResponses(request.body ?? {});
    const preparedBody = await prepareCodexRequest(body);
    const structuredFormat = request.body?.text?.format;
    const structured = Boolean(jsonSchemaFromFormat(structuredFormat));

    if (request.body?.stream) {
      // Structured responses are collected and validated before HTTP 200 is committed. This lets
      // upstream 429/4xx/5xx and schema failures retain their real HTTP status instead of becoming
      // a successful SSE connection followed by an error event.
      const bufferedEvents = structured
        ? await collectCodexResponseEvents(preparedBody, { prepared: true })
        : [];
      if (structured) {
        validateStructuredOutput(collectTextFromCodexEvents(bufferedEvents), structuredFormat);
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });

      try {
        if (structured) {
          for (const event of bufferedEvents) writeSSE(reply, event);
        } else {
          await streamCodexResponseToSSE(
            preparedBody,
            reply,
            (event: CodexEvent) => writeSSE(reply, event),
            { prepared: true },
          );
        }

        reply.raw.write("data: [DONE]\n\n");
      } catch (error) {
        request.log.error(error);
        writeSSEError(reply, error);
        reply.raw.write("data: [DONE]\n\n");
      }

      reply.raw.end();
      return reply;
    }

    const events = await collectCodexResponseEvents(preparedBody, { prepared: true });
    const text = collectTextFromCodexEvents(events);
    validateStructuredOutput(text, structuredFormat);
    const responseCompletedEvent = events.find((event) => event.type === "response.completed");
    const responseObject = responseCompletedEvent?.response as Record<string, unknown> | undefined;
    const responseIdValue = responseObject?.id;
    const responseId =
      typeof responseIdValue === "string"
        ? responseIdValue
        : `resp_${Date.now()}`;

    return createOpenAIResponsesOutput(responseId, body.model, text);
  });

  app.post<{ Body: OpenAIChatCompletionsRequest }>(
    "/v1/chat/completions",
    async (request, reply) => {
      logIgnoredParameters(
        request.log,
        (request.body ?? {}) as Record<string, unknown>,
        ["model", "messages", "stream", "reasoning_effort"],
      );

      const body = buildCodexResponsesRequestFromChatCompletions(request.body ?? {});
      const model = normalizeModelName(request.body?.model);
      const preparedBody = await prepareCodexRequest(body);

      if (request.body?.stream) {
        const responseId = `chatcmpl_${Date.now()}`;

        reply.hijack();
        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        });

        try {
          await streamCodexResponseToSSE(preparedBody, reply, (event: CodexEvent) => {
            if (event.type === "response.output_text.delta" && event.delta) {
              writeSSE(reply, createChatCompletionChunk(responseId, model, event.delta));
            }
            if (event.type === "response.completed") {
              writeSSE(reply, createChatCompletionDoneChunk(responseId, model));
            }
          }, { prepared: true });

          reply.raw.write("data: [DONE]\n\n");
        } catch (error) {
          request.log.error(error);
          writeSSEError(reply, error);
          reply.raw.write("data: [DONE]\n\n");
        }

        reply.raw.end();
        return reply;
      }

      const events = await collectCodexResponseEvents(preparedBody, { prepared: true });
      const text = collectTextFromCodexEvents(events);
      const responseCompletedEvent = events.find((event) => event.type === "response.completed");
      const responseObject = responseCompletedEvent?.response as Record<string, unknown> | undefined;
      const responseIdValue = responseObject?.id;
      const responseId =
        typeof responseIdValue === "string"
          ? responseIdValue
          : `chatcmpl_${Date.now()}`;

      return createChatCompletion(responseId, model, text);
    },
  );
}
