/*
 * Implementation notes:
 * Converts public OpenAI request structures into Codex backend Responses payloads and maps Codex
 * events back to OpenAI Responses or Chat Completions output. Application instructions become a
 * developer message; the client obtains the model's base instructions from the model catalog.
 */

import type {
  CodexInputItem,
  CodexEvent,
  CodexResponsesRequest,
  OpenAIChatCompletionsRequest,
  OpenAIChatMessage,
  OpenAIResponsesInputMessage,
  OpenAIResponsesRequest,
} from "./types.js";
import { OpenAIProxyError } from "./errors.js";
import { jsonSchemaFromFormat } from "./schema.js";

export const DEFAULT_MODEL = "gpt-5.6-sol";

export function normalizeModelName(model?: string) {
  if (!model) return DEFAULT_MODEL;
  return model;
}

function toInputTextParts(content: OpenAIChatMessage["content"]) {
  if (!content) return [];
  if (typeof content === "string") {
    return [{ type: "input_text" as const, text: content }];
  }

  return content
    .filter((part) => part.type === "text" || part.type === "input_text")
    .map((part) => ({
      type: "input_text" as const,
      text: part.text,
    }));
}

function createMessage(
  role: "developer" | "user" | "assistant",
  text: string,
): OpenAIResponsesInputMessage {
  return {
    type: "message",
    role,
    content: [
      {
        type: role === "assistant" ? "output_text" : "input_text",
        text,
      },
    ],
  };
}

function normalizeResponsesInput(input: OpenAIResponsesRequest["input"]): CodexInputItem[] {
  if (typeof input === "string") {
    return [createMessage("user", input)];
  }

  return (input ?? []).map((item) => {
    if (
      item.type !== "message" ||
      !("role" in item) ||
      !("content" in item) ||
      !["system", "developer", "user", "assistant"].includes(String(item.role))
    ) {
      return item;
    }

    const message = item as OpenAIResponsesInputMessage;

    const role = message.role === "system" ? "developer" : message.role;
    if (typeof message.content === "string") {
      return createMessage(role, message.content);
    }

    const content = message.content.map((part) => {
      if (role === "assistant") {
        if (part.type !== "input_text" && part.type !== "output_text") {
          throw new OpenAIProxyError({
            status: 400,
            type: "invalid_request_error",
            code: "unsupported_content_type",
            message: `Assistant messages do not support content type: ${part.type}`,
          });
        }
        return { type: "output_text" as const, text: part.text };
      }
      if (["input_text", "input_file", "input_image"].includes(part.type)) return part;
      throw new OpenAIProxyError({
        status: 400,
        type: "invalid_request_error",
        code: "unsupported_content_type",
        message: `User messages do not support content type: ${part.type}`,
      });
    });

    return {
      ...message,
      role,
      content,
    };
  });
}

function prependDeveloperInstructions(input: CodexInputItem[], instructions?: string) {
  if (!instructions?.trim()) return input;
  return [createMessage("developer", instructions), ...input];
}

export function chatCompletionsToResponsesInput(
  request: OpenAIChatCompletionsRequest,
): { instructions?: string; input: OpenAIResponsesInputMessage[] } {
  const instructions = request.messages
      ?.filter((message) => message.role === "system" || message.role === "developer")
    .flatMap((message) => toInputTextParts(message.content))
    .map((part) => part.text)
    .join("\n");

  const input =
    request.messages
      ?.filter((message) => message.role !== "system" && message.role !== "developer")
      .map((message) => ({
        type: "message" as const,
        role: message.role === "tool" ? "user" as const : message.role,
        content: toInputTextParts(message.content).map((part) => ({
          ...part,
          type: message.role === "assistant" ? "output_text" as const : part.type,
        })),
      }))
      .filter((message) => message.content.length > 0) ?? [];

  return {
    instructions: instructions || undefined,
    input,
  };
}

export function buildCodexResponsesRequestFromResponses(
  request: OpenAIResponsesRequest,
): CodexResponsesRequest {
  const input = normalizeResponsesInput(request.input);
  jsonSchemaFromFormat(request.text?.format);

  return {
    model: normalizeModelName(request.model),
    store: false,
    stream: true,
    // The client replaces this field with the model's official base instructions.
    instructions: "",
    input: prependDeveloperInstructions(input, request.instructions),
    reasoning: request.reasoning?.effort
      ? { effort: request.reasoning.effort }
      : undefined,
    text: request.text,
    include: ["reasoning.encrypted_content"],
    tool_choice: "auto",
    parallel_tool_calls: true,
  };
}

export function buildCodexResponsesRequestFromChatCompletions(
  request: OpenAIChatCompletionsRequest,
): CodexResponsesRequest {
  const converted = chatCompletionsToResponsesInput(request);

  return {
    model: normalizeModelName(request.model),
    store: false,
    stream: true,
    // The client replaces this field with the model's official base instructions.
    instructions: "",
    input: prependDeveloperInstructions(converted.input, converted.instructions),
    reasoning: request.reasoning_effort
      ? { effort: request.reasoning_effort }
      : undefined,
    include: ["reasoning.encrypted_content"],
    tool_choice: "auto",
    parallel_tool_calls: true,
  };
}

export function createOpenAIResponsesOutput(responseId: string, model: string, text: string) {
  return {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    output: [
      {
        id: `${responseId}_msg`,
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text,
            annotations: [],
          },
        ],
      },
    ],
    model,
  };
}

export function createChatCompletion(responseId: string, model: string, text: string) {
  const created = Math.floor(Date.now() / 1000);
  return {
    id: responseId,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: text,
        },
      },
    ],
  };
}

export function createChatCompletionChunk(responseId: string, model: string, delta: string) {
  return {
    id: responseId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {
          content: delta,
        },
        finish_reason: null,
      },
    ],
  };
}

export function createChatCompletionDoneChunk(responseId: string, model: string) {
  return {
    id: responseId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
      },
    ],
  };
}

export function collectTextFromCodexEvents(events: CodexEvent[]) {
  const deltas = events
    .filter((event) => event.type === "response.output_text.delta")
    .map((event) => event.delta ?? "")
    .join("");

  if (deltas) return deltas;

  return events
    .filter((event) => event.type === "response.output_text.done")
    .map((event) => event.text ?? "")
    .join("");
}
