/*
 * Implementation notes:
 * Centralizes server startup: validates the configured authentication file, initializes Fastify,
 * registers the OpenAI-compatible routes, and prints connection details. The CLI and future
 * programmatic callers share this startup path.
 */

import Fastify from "fastify";

import { resolveCodexAuthFilePath, validateCodexAuthFile } from "./auth.js";
import { configureCodexClient } from "./codex-client.js";
import { registerRoutes } from "./routes.js";

export type StartServerOptions = {
  host: string;
  port: number;
  authFile: string;
};

function printStartupSummary(options: StartServerOptions) {
  const serviceUrl = `http://${options.host}:${options.port}`;

  console.log("");
  console.log("codex-openai-proxy is running");
  console.log(`Service URL: ${serviceUrl}`);
  console.log(`Authentication file: ${options.authFile}`);
  console.log(`Health check: ${serviceUrl}/health`);
  console.log(`Model list: ${serviceUrl}/v1/models`);
  console.log(`OpenAI baseURL: ${serviceUrl}/v1`);
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
  };
  const validated = validateCodexAuthFile(normalizedOptions.authFile);

  configureCodexClient({ authFilePath: validated.authPath });

  const app = Fastify({
    logger: true,
  });

  await registerRoutes(app);
  await app.listen({ host: normalizedOptions.host, port: normalizedOptions.port });

  printStartupSummary({
    host: normalizedOptions.host,
    port: normalizedOptions.port,
    authFile: validated.authPath,
  });

  return app;
}
