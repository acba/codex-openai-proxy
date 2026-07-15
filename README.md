# codex-openai-proxy

> Maintained fork of [thkdog/codex-openai-proxy](https://github.com/thkdog/codex-openai-proxy),
> originally created by [shenyi (thkdog)](https://github.com/thkdog). This fork preserves the
> original work and adds updated Codex backend compatibility and OpenAI-compatible behavior.

A local OpenAI-compatible proxy that reuses local Codex / ChatGPT auth state and forwards requests to `https://chatgpt.com/backend-api/codex/*`.

It exposes OpenAI-style endpoints so existing OpenAI SDK integrations and tools can work with minimal changes.

Currently supported:

- `GET /health`
- `GET /v1/models`
- `POST /v1/responses`
- `POST /v1/chat/completions`

## Codex compatibility

Version 1.2.0 tracks the Codex CLI 0.144.1 backend protocol. It uses the current authenticated
WebSocket transport, request headers, model catalog, and model-specific base instructions. The
default model is `gpt-5.6-sol`; use `GET /v1/models` to see the models available to your account.

### Supported Responses features

- streaming and non-streaming Responses;
- `reasoning.effort` validated against the selected model catalog;
- `input_text`, PDF `input_file`, and `input_image` content parts;
- `text.verbosity`;
- strict `text.format.type=json_schema` Structured Outputs;
- OpenAI-style error envelopes and HTTP status codes before streaming starts;
- structured SSE errors for failures after streaming starts.

Structured responses are buffered until their JSON Schema is validated. This intentionally delays
their SSE deltas: invalid JSON is returned as `json_schema_validation_failed`, never as a successful
partial response. The dependency-free validator supports the schema subset used by this proxy:
`type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `description`, and
`title`. Unsupported keywords fail with `unsupported_json_schema` instead of being ignored.

## Quick Start

### 1. Prerequisites

- Node.js 18+
- You are already signed in to Codex / ChatGPT on this machine
- Default auth file path: `~/.codex/auth.json`

You can verify the auth file exists:

```bash
ls ~/.codex/auth.json
```

### 2. Run with npx

```bash
npx @acba/codex-openai-proxy
```

Default listen address:

```text
http://127.0.0.1:8787
```

If you are developing inside this repository, you can also run:

```bash
npm install
npm run dev
```

On startup, the server prints:

- service URL
- active auth file path
- health check URL
- models URL
- OpenAI SDK `baseURL`
- copy-paste `curl` commands for verification

## CLI Options

This project uses command-line arguments only and does not read environment variables.

Show help:

```bash
npx @acba/codex-openai-proxy --help
```

Available options:

- `-H, --host <host>`: listen host, default `127.0.0.1`
- `-p, --port <port>`: listen port, default `8787`
- `-a, --auth-file <path>`: auth file path, default `~/.codex/auth.json`

Examples:

```bash
npx @acba/codex-openai-proxy --port 9000
```

```bash
npx @acba/codex-openai-proxy --host 0.0.0.0 --port 9000
```

```bash
npx @acba/codex-openai-proxy --auth-file ~/.codex/auth.json
```

```bash
npx @acba/codex-openai-proxy --host 0.0.0.0 --port 9000 --auth-file ~/.codex/auth.json
```

You can also install it globally:

```bash
npm install -g @acba/codex-openai-proxy
codex-openai-proxy --port 9000
```

## Verify

Health check:

```bash
curl http://127.0.0.1:8787/health
```

List models:

```bash
curl http://127.0.0.1:8787/v1/models
```

Root info page:

```bash
curl http://127.0.0.1:8787/
```

## curl Examples

Non-streaming `chat/completions`:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-5.6-sol",
    "messages": [
      { "role": "user", "content": "Reply with exactly ok" }
    ]
  }'
```

Streaming `chat/completions`:

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-5.6-sol",
    "stream": true,
    "messages": [
      { "role": "user", "content": "Reply with exactly ok" }
    ]
  }'
```

Non-streaming `responses`:

```bash
curl http://127.0.0.1:8787/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-5.6-sol",
    "input": [
      {
        "type": "message",
        "role": "user",
        "content": [
          { "type": "input_text", "text": "Reply with exactly ok" }
        ]
      }
    ]
  }'
```

Structured `responses`:

```bash
curl http://127.0.0.1:8787/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-5.6-luna",
    "input": "Return a valid result object.",
    "text": {
      "format": {
        "type": "json_schema",
        "name": "result",
        "strict": true,
        "schema": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "status": { "type": "string", "enum": ["completed"] }
          },
          "required": ["status"]
        }
      }
    }
  }'
```

PDF input uses the standard data URL shape:

```json
{
  "type": "input_file",
  "filename": "evidence.pdf",
  "file_data": "data:application/pdf;base64,..."
}
```

## OpenAI SDK Example

Install the official SDK first:

```bash
npm install openai
```

`chat/completions` example:

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "dummy",
  baseURL: "http://127.0.0.1:8787/v1",
});

const result = await client.chat.completions.create({
  model: "gpt-5.6-sol",
  messages: [
    { role: "user", content: "Reply with exactly ok" },
  ],
});

console.log(result.choices[0]?.message?.content);
```

`responses` example:

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "dummy",
  baseURL: "http://127.0.0.1:8787/v1",
});

const result = await client.responses.create({
  model: "gpt-5.6-sol",
  input: "Reply with exactly ok",
});

console.log(result.output_text);
```

## Reasoning effort

Use the standard Responses API `reasoning.effort` field:

```ts
const result = await client.responses.create({
  model: "gpt-5.6-luna",
  reasoning: { effort: "xhigh" },
  input: "Solve this difficult problem.",
});
```

For Chat Completions, use `reasoning_effort`:

```ts
const result = await client.chat.completions.create({
  model: "gpt-5.6-luna",
  reasoning_effort: "high",
  messages: [{ role: "user", content: "Solve this difficult problem." }],
});
```

Codex 0.144.1 exposes `low`, `medium`, `high`, `xhigh`, and `max` for
`gpt-5.6-luna`. A fully non-reasoning mode is not available; use `low` for the lightest reasoning.

## iGovTI evidence evaluation

The iGovTI provider can use this proxy without an API key:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
```

Recommended evaluator route:

```json
{
  "provider": "openai",
  "model": "gpt-5.6-luna",
  "model_key": "gpt-5.6-luna",
  "reasoning": "high",
  "pdf2md": false,
  "docx2html": false
}
```

The proxy preserves the nested JSON Schema used by manager-comments temporal reassessments and
validates the completed output before releasing it to the client.

## Error behavior

Errors use the OpenAI-compatible envelope:

```json
{
  "error": {
    "message": "...",
    "type": "rate_limit_error",
    "code": "rate_limit_exceeded"
  }
}
```

Invalid models and reasoning levels return HTTP 400. Authentication failures return 401, rate
limits return 429 when known before streaming, upstream timeouts return 504, and invalid structured
model output returns 502. Once SSE headers have been sent, the same status is included in a
structured `type=error` event.

The service logs request metadata through Fastify but must not log access tokens, account IDs,
auth file contents, full prompts, data URLs, or attachment contents.

## Troubleshooting

Auth file not found:

- the default path is not `~/.codex/auth.json`
- pass `--auth-file` explicitly
- `--auth-file ~/.codex/auth.json` is supported and `~` will be expanded automatically

Invalid auth file:

- the file is not valid JSON
- or it is missing `tokens.access_token`
- or it is missing `tokens.account_id`

Port issues:

- `--port` must be an integer between `1` and `65535`
- or the port is already in use

Expired Codex auth state:

- `/health` works but `/v1/models` fails
- in that case you usually need to sign in to Codex / ChatGPT again so the local auth file is refreshed
