/*
 * Implementation notes:
 * This file defines the public OpenAI-compatible request structures and the minimum internal
 * Codex backend API types shared by the routes, transformation layer, and backend client.
 */

export type OpenAIMessageContentPart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "input_text";
      text: string;
    };

export type OpenAIChatMessage = {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | OpenAIMessageContentPart[];
  tool_call_id?: string;
};

export type OpenAIInputText = {
  type: "input_text";
  text: string;
};

export type OpenAIOutputText = {
  type: "output_text";
  text: string;
};

export type OpenAIInputFile = {
  type: "input_file";
  filename: string;
  file_data: string;
  detail?: "auto" | "low" | "high";
};

export type OpenAIInputImage = {
  type: "input_image";
  image_url: string;
};

export type OpenAIResponsesContentPart =
  | OpenAIInputText
  | OpenAIOutputText
  | OpenAIInputFile
  | OpenAIInputImage;

export type OpenAIResponsesInputMessage = {
  type: "message";
  role: "system" | "developer" | "user" | "assistant";
  content: string | OpenAIResponsesContentPart[];
};

export type CodexInputItem =
  | OpenAIResponsesInputMessage
  | {
      type: string;
      [key: string]: unknown;
    };

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type OpenAIReasoning = {
  effort?: ReasoningEffort | string;
};

export type OpenAIJsonSchema = {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, OpenAIJsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: OpenAIJsonSchema;
  enum?: unknown[];
  description?: string;
  title?: string;
  [key: string]: unknown;
};

export type OpenAITextFormat =
  | { type: "text" }
  | {
      type: "json_schema";
      name: string;
      strict?: boolean;
      schema: OpenAIJsonSchema;
    };

export type OpenAITextConfig = {
  verbosity?: "low" | "medium" | "high";
  format?: OpenAITextFormat;
};

export type OpenAIResponsesRequest = {
  model?: string;
  instructions?: string;
  input?: string | CodexInputItem[];
  stream?: boolean;
  reasoning?: OpenAIReasoning;
  text?: OpenAITextConfig;
  temperature?: number;
};

export type OpenAIChatCompletionsRequest = {
  model?: string;
  messages?: OpenAIChatMessage[];
  stream?: boolean;
  reasoning_effort?: ReasoningEffort | string;
  temperature?: number;
};

export type CodexResponsesRequest = {
  model: string;
  store: false;
  stream: true;
  instructions: string;
  input: CodexInputItem[];
  text?: OpenAITextConfig;
  reasoning?: {
    effort: ReasoningEffort | string;
  };
  include: string[];
  prompt_cache_key?: string;
  tool_choice: "auto";
  parallel_tool_calls: boolean;
};

export type CodexModelEntry = {
  slug: string;
  display_name?: string;
  description?: string;
  base_instructions?: string;
  visibility?: "list" | "hide" | string;
  supported_in_api?: boolean;
  priority?: number;
  support_verbosity?: boolean;
  default_verbosity?: "low" | "medium" | "high";
  supports_parallel_tool_calls?: boolean;
  default_reasoning_level?: ReasoningEffort;
  supported_reasoning_levels?: Array<{
    effort: ReasoningEffort;
    description?: string;
  }>;
};

export type CodexEvent =
  | {
      type: "codex.rate_limits";
      [key: string]: unknown;
    }
  | {
      type:
        | "response.created"
        | "response.in_progress"
        | "response.completed"
        | "response.failed"
        | "response.incomplete";
      response?: Record<string, unknown>;
      [key: string]: unknown;
    }
  | {
      type: "response.output_text.delta";
      delta?: string;
      [key: string]: unknown;
    }
  | {
      type: "response.output_text.done";
      text?: string;
      [key: string]: unknown;
    }
  | {
      type: "response.output_item.done";
      item?: Record<string, unknown>;
      [key: string]: unknown;
    }
  | {
      type: "error";
      error?: {
        type?: string;
        code?: string;
        message?: string;
        retry_after_seconds?: number;
      };
      status?: number;
      retry_after_seconds?: number;
      [key: string]: unknown;
    };
