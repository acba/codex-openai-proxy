#!/usr/bin/env node
/*
 * Implementation notes:
 * This npm package entry point parses CLI options, validates the port, and passes normalized
 * startup settings to the server so local development, npx, and global installs use one path.
 */

import { Command, InvalidArgumentError } from "commander";

import { getDefaultCodexAuthFilePath } from "./auth.js";
import { startServer } from "./index.js";

function parsePort(value: string) {
  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidArgumentError("port must be an integer between 1 and 65535");
  }

  return port;
}

async function main() {
  const program = new Command();

  program
    .name("codex-openai-proxy")
    .description("Expose local Codex authentication through an OpenAI-compatible API")
    .option("-H, --host <host>", "listen address", "127.0.0.1")
    .option("-p, --port <port>", "listen port", parsePort, 8787)
    .option("-a, --auth-file <path>", "Codex authentication file", getDefaultCodexAuthFilePath())
    .showHelpAfterError("(use --help to view all startup options)");

  program.parse();

  const options = program.opts<{
    host: string;
    port: number;
    authFile: string;
  }>();

  await startServer({
    host: options.host,
    port: options.port,
    authFile: options.authFile,
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Startup failed: ${message}`);
  process.exit(1);
});
