/*
 * Implementation notes:
 * Centralizes server startup: validates the configured authentication file, initializes Fastify,
 * registers the OpenAI-compatible routes, and prints connection details. The CLI and future
 * programmatic callers share this startup path.
 */

import Fastify from "fastify";

import { resolveCodexAuthFilePath, validateCodexAuthFile } from "./auth.js";
import { configureCodexClient, getCodexClientVersion } from "./codex-client.js";
import { registerRoutes } from "./routes.js";

export const DEFAULT_BODY_LIMIT_MB = 75;
export const DEFAULT_BODY_LIMIT_BYTES = DEFAULT_BODY_LIMIT_MB * 1024 * 1024;

export type StartServerOptions = {
  host: string;
  port: number;
  authFile: string;
  bodyLimitBytes?: number;
};

export type CreateProxyServerOptions = {
  bodyLimitBytes?: number;
  logger?: boolean;
};

export async function createProxyServer(options: CreateProxyServerOptions = {}) {
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES,
  });
  await registerRoutes(app);
  return app;
}

function printStartupSummary(options: StartServerOptions) {
  const serviceUrl = `http://${options.host}:${options.port}`;

  console.log("");
  console.log("codex-openai-proxy is running");
  console.log(`Codex CLI version: ${getCodexClientVersion()}`);
  console.log(`Service URL: ${serviceUrl}`);
  console.log(`Authentication file: ${options.authFile}`);
  console.log(`Health check: ${serviceUrl}/health`);
  console.log(`Model list: ${serviceUrl}/v1/models`);
  console.log(`OpenAI baseURL: ${serviceUrl}/v1`);
  const bodyLimitMb = Math.floor(
    (options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES) / 1024 / 1024,
  );
  console.log(`Request body limit: ${bodyLimitMb} MiB`);
  console.log("");
  console.log("Quick verification:");
  console.log(`curl ${serviceUrl}/health`);
  console.log(`curl ${serviceUrl}/v1/models`);
  console.log("");
  console.log("OpenAI SDK configuration:");
  console.log(`baseURL = "${serviceUrl}/v1"`);
  console.log('apiKey = "dummy"');
  console.log("");
}

export async function startServer(options: StartServerOptions) {
  const normalizedOptions = {
    host: options.host,
    port: options.port,
    authFile: resolveCodexAuthFilePath(options.authFile),
    bodyLimitBytes: options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES,
  };
  const validated = validateCodexAuthFile(normalizedOptions.authFile);

  configureCodexClient({ authFilePath: validated.authPath });

  const app = await createProxyServer({ bodyLimitBytes: normalizedOptions.bodyLimitBytes });
  await app.listen({ host: normalizedOptions.host, port: normalizedOptions.port });

  printStartupSummary({
    host: normalizedOptions.host,
    port: normalizedOptions.port,
    authFile: validated.authPath,
    bodyLimitBytes: normalizedOptions.bodyLimitBytes,
  });

  return app;
}
