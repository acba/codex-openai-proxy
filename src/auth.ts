/*
 * Implementation notes:
 * Reads and parses the ChatGPT/Codex authentication file. It defaults to ~/.codex/auth.json,
 * accepts a custom path from the CLI, and validates the access_token/account_id pair used by the
 * backend API client.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type RawAuthFile = {
  tokens?: {
    access_token?: string;
    account_id?: string;
  };
};

export type CodexAuth = {
  accessToken: string;
  accountId: string;
};

export function getDefaultCodexAuthFilePath() {
  return path.join(os.homedir(), ".codex", "auth.json");
}

export function resolveCodexAuthFilePath(authFilePath?: string) {
  if (!authFilePath) {
    return getDefaultCodexAuthFilePath();
  }

  if (authFilePath === "~") {
    return os.homedir();
  }

  if (authFilePath.startsWith("~/")) {
    return path.join(os.homedir(), authFilePath.slice(2));
  }

  return path.resolve(authFilePath);
}

export function validateCodexAuthFile(authFilePath?: string) {
  const authPath = resolveCodexAuthFilePath(authFilePath);

  if (!fs.existsSync(authPath)) {
    throw new Error(`Authentication file does not exist: ${authPath}`);
  }

  const raw = fs.readFileSync(authPath, "utf8");
  let parsed: RawAuthFile;

  try {
    parsed = JSON.parse(raw) as RawAuthFile;
  } catch {
    throw new Error(`Authentication file is not valid JSON: ${authPath}`);
  }

  const accessToken = parsed.tokens?.access_token;
  const accountId = parsed.tokens?.account_id;

  if (!accessToken || !accountId) {
    throw new Error(`Authentication file is missing access_token or account_id: ${authPath}`);
  }

  return {
    authPath,
    auth: {
      accessToken,
      accountId,
    },
  };
}

export function readCodexAuth(authFilePath?: string): CodexAuth {
  return validateCodexAuthFile(authFilePath).auth;
}
