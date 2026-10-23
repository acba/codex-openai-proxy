# AGENTS.md

## Project goal

This is a local OpenAI-compatible proxy service. Version 2.1.0:

- exposes OpenAI-style public endpoints;
- reads `~/.codex/auth.json` internally;
- uses its `access_token` and `account_id`;
- proxies requests to `https://chatgpt.com/backend-api/codex/*`;
- preserves the OpenAI request and error contracts needed by SDK consumers.

Currently implemented endpoints:

- `GET /health`
- `GET /v1/models`
- `GET /v1/models/reasoning` (proxy extension)
- `GET /v1/models/:model/reasoning` (proxy extension)
- `POST /v1/responses`
- `POST /v1/chat/completions`

## Development constraints

- Keep an "Implementation notes" comment at the top of business logic files.
- Use TypeScript by default.
- Prefer minimal dependencies and dependency-free validation when practical.
- Do not introduce heavyweight frameworks unless necessary.
- Prioritize compatibility with official OpenAI SDK request and response shapes.
- Reject unsupported parameters or schema keywords explicitly; never silently drop or reinterpret them.
- Preserve unrelated user changes in a dirty worktree.

## Authentication and security constraints

- Do not implement an OAuth login flow.
- Do not require users to provide `OPENAI_API_KEY`.
- Read `~/.codex/auth.json` directly.
- If token refresh is added later, use fields already present in the local auth file.
- Do not log access tokens, account IDs, authorization headers, file payloads, image payloads, or full prompts.
- Keep the default listener on `127.0.0.1`; document the security impact before exposing the proxy on another interface.

## OpenAI compatibility constraints

- Keep public endpoints as close as possible to the OpenAI standard format.
- Follow the real Codex backend request format internally.
- `chat/completions` may be converted internally to `codex/responses`.
- Preserve `instructions`, `reasoning.effort`, `text.verbosity`, and `text.format` during normalization and model-default application.
- Preserve supported Responses content parts: `input_text`, PDF `input_file`, and `input_image`.
- Reject unsupported content-part types with an OpenAI-style 400 error.
- Validate requested reasoning effort against the selected model catalog before starting a response.
- Return OpenAI-style error envelopes with meaningful HTTP status and error codes.
- Preserve rate-limit status and `Retry-After` metadata when supplied upstream.

## Structured Outputs and streaming

- `text.format.type=json_schema` is a strict contract, not a prompt hint.
- Validate the schema before calling the backend and validate the model output before reporting success.
- The supported schema subset is `type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `description`, and `title`.
- Return `unsupported_json_schema` for unsupported keywords instead of ignoring them.
- Return an upstream/output error when the model produces invalid JSON or violates the schema.
- Buffer structured streaming responses until validation succeeds. Do not emit HTTP 200 or successful partial SSE output before that validation.
- Keep ordinary, non-structured SSE responses incremental.
- Treat upstream `response.incomplete` as an error, not a completed response.

## Current boundaries

The service does not expose standalone OpenAI endpoints for:

- embeddings;
- image generation or editing;
- file upload or management;
- realtime;
- assistants.

PDF `input_file` and `input_image` content inside `POST /v1/responses` are supported. This does not imply support for `/v1/files` or `/v1/images`.

## Code organization

- `src/auth.ts`: local authentication file reader.
- `src/codex-client.ts`: model catalog, Codex backend communication, preparation, collection, and SSE transport.
- `src/transform.ts`: OpenAI/Codex request and response normalization.
- `src/schema.ts`: supported JSON Schema validation and structured-output validation.
- `src/errors.ts`: normalized OpenAI-compatible errors and status mapping.
- `src/types.ts`: public and internal request/event types.
- `src/routes.ts`: public HTTP routes, early validation, buffering decisions, and error responses.
- `src/index.ts`: server construction and startup wiring.
- `src/cli.ts`: command-line entry point and listen/auth-file options.
- `test/compatibility.test.mjs`: compatibility regression coverage.

## Validation requirements

Run the existing test command after behavior changes:

```bash
npm test
```

It compiles TypeScript before running the compatibility tests. Add or update tests when changing:

- request normalization or supported content parts;
- model defaults and reasoning validation;
- JSON Schema preservation or validation;
- HTTP status/error mapping, especially 429 behavior;
- structured or ordinary streaming behavior.

For integration-sensitive changes, also verify `GET /health`, `GET /v1/models`, one non-streaming Responses request, and the affected multimodal or structured request against a locally running proxy. Tests that call the real backend require a valid local Codex authentication file and must not print its contents.
