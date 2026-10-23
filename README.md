# codex-openai-proxy

> Maintained fork of [thkdog/codex-openai-proxy](https://github.com/thkdog/codex-openai-proxy),
> originally created by [shenyi (thkdog)](https://github.com/thkdog). This fork preserves the
> original work and adds updated Codex backend compatibility and OpenAI-compatible behavior.

A local OpenAI-compatible proxy that reuses local Codex / ChatGPT auth state and forwards requests to `https://chatgpt.com/backend-api/codex/*`.

It exposes OpenAI-style endpoints so existing OpenAI SDK integrations and tools can work with minimal changes.

Currently supported:

- `GET /health`
- `GET /v1/models`
- `GET /v1/models/reasoning` (proxy extension)
- `GET /v1/models/:model/reasoning` (proxy extension)
- `POST /v1/responses`
- `POST /v1/chat/completions`

## Codex compatibility

The proxy detects the installed Codex CLI version by running `codex --version` at startup and
uses that version in the model catalog query and backend request headers. It uses authenticated
WebSocket transport, the model catalog, and model-specific base instructions. The
default model is `gpt-5.6-sol`; use `GET /v1/models` to see the models available to your account.

After updating Codex CLI, restart the proxy to detect the new version and refresh its catalog.
Startup fails with an actionable error if `codex` is missing from `PATH`, takes more than five
seconds to report its version, or returns an unrecognized version. Detecting the version does
not automatically adapt the proxy to future changes in the backend protocol.

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

- Node.js 22.12.0+
- You are already signed in to Codex / ChatGPT on this machine
- Codex CLI is installed and `codex --version` works on `PATH`
- Default auth file path: `~/.codex/auth.json`

You can verify the auth file exists:

```bash
ls ~/.codex/auth.json
```

### 2. Run with npx

```bash
npx @abenvenuto/codex-openai-proxy
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
- detected Codex CLI version
- active auth file path
- health check URL
- models URL
- OpenAI SDK `baseURL`
- copy-paste `curl` commands for verification

## CLI Options

This project uses command-line arguments only and does not read environment variables.

Show help:

```bash
npx @abenvenuto/codex-openai-proxy --help
```

Available options:

- `-H, --host <host>`: listen host, default `127.0.0.1`
- `-p, --port <port>`: listen port, default `8787`
- `-a, --auth-file <path>`: auth file path, default `~/.codex/auth.json`
- `--body-limit-mb <mb>`: maximum JSON request body size, default `75` MiB

The larger default body limit is required for Base64 file inputs. OpenAI accepts up to 50 MB of
files per request, while Base64 expands the binary data by roughly one third. Fastify's original
1 MiB default is therefore too small for ordinary PDF evidence. Because request bodies are parsed
in memory, keep the listener on `127.0.0.1` and reduce this limit when large file inputs are not
needed.

Examples:

```bash
npx @abenvenuto/codex-openai-proxy --port 9000
```

```bash
npx @abenvenuto/codex-openai-proxy --body-limit-mb 75
```

```bash
npx @abenvenuto/codex-openai-proxy --host 0.0.0.0 --port 9000
```

```bash
npx @abenvenuto/codex-openai-proxy --auth-file ~/.codex/auth.json
```

```bash
npx @abenvenuto/codex-openai-proxy --host 0.0.0.0 --port 9000 --auth-file ~/.codex/auth.json
```

You can also install it globally:

```bash
npm install -g @abenvenuto/codex-openai-proxy
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

Query the accepted levels for every available model, or for one model:

```bash
curl http://127.0.0.1:8787/v1/models/reasoning
curl http://127.0.0.1:8787/v1/models/gpt-5.6-luna/reasoning
```

The individual endpoint returns this shape (illustrative values):

```json
{
  "id": "gpt-5.6-luna",
  "object": "model_reasoning",
  "default_reasoning_level": "medium",
  "supported_reasoning_levels": [
    { "effort": "low", "description": "Fast reasoning" },
    { "effort": "medium" },
    { "effort": "high" }
  ]
}
```

The list endpoint wraps these objects in `{ "object": "list", "data": [...] }`.
Both endpoints use the same account-specific Codex catalog and five-minute cache as request
validation. Descriptions are included when supplied by the catalog. Missing metadata appears as
`default_reasoning_level: null` and `supported_reasoning_levels: []`; no levels are inferred.
Unknown, hidden, or API-unavailable models return HTTP 404 with `model_not_found` on the individual
endpoint. These routes are proxy extensions; `/v1/models` retains its OpenAI-compatible shape.

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

Accepted levels vary by model and catalog version. Use the reasoning endpoints above to check
the current values before setting `reasoning.effort` or `reasoning_effort`.

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
