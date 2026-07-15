/*
 * Implementation notes:
 * Defines OpenAI-compatible proxy errors and normalizes upstream/backend failures into stable
 * HTTP status, type, code, message, and optional retry metadata.
 */

export class OpenAIProxyError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code: string;
  readonly retryAfter?: number;

  constructor(options: {
    status: number;
    type: string;
    code: string;
    message: string;
    retryAfter?: number;
  }) {
    super(options.message);
    this.name = "OpenAIProxyError";
    this.status = options.status;
    this.type = options.type;
    this.code = options.code;
    this.retryAfter = options.retryAfter;
  }
}

function statusFromMessage(message: string) {
  const match = message.match(/(?:status(?: code)?|http)?\s*[:=]?\s*(4\d\d|5\d\d)\b/i);
  if (match) return Number(match[1]);
  if (/rate.?limit|too many requests|resource_exhausted/i.test(message)) return 429;
  if (/unauthori[sz]ed|authentication|access token|auth file/i.test(message)) return 401;
  if (/timed?\s*out|timeout/i.test(message)) return 504;
  return 502;
}

function errorMetadata(status: number) {
  if (status === 429) {
    return { type: "rate_limit_error", code: "rate_limit_exceeded" };
  }
  if (status === 401 || status === 403) {
    return { type: "authentication_error", code: "authentication_failed" };
  }
  if (status >= 400 && status < 500) {
    return { type: "invalid_request_error", code: "invalid_request" };
  }
  if (status === 504) {
    return { type: "timeout_error", code: "upstream_timeout" };
  }
  return { type: "upstream_error", code: "upstream_failure" };
}

export function normalizeProxyError(error: unknown): OpenAIProxyError {
  if (error instanceof OpenAIProxyError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const candidate = error as { status?: unknown; statusCode?: unknown } | null;
  const explicitStatus = typeof candidate?.status === "number"
    ? candidate.status
    : typeof candidate?.statusCode === "number"
      ? candidate.statusCode
      : undefined;
  const status = explicitStatus ?? statusFromMessage(message);
  return new OpenAIProxyError({ status, message, ...errorMetadata(status) });
}

export function openAIErrorBody(error: unknown) {
  const normalized = normalizeProxyError(error);
  return {
    error: {
      message: normalized.message,
      type: normalized.type,
      code: normalized.code,
    },
  };
}
