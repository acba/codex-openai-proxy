/*
 * Implementation notes:
 * Detects the installed Codex CLI version through PATH without a shell. Detection is bounded
 * and fails explicitly rather than advertising an obsolete backend protocol version.
 */

import childProcess from "node:child_process";

export function detectCodexVersion(): string {
  let output: string;
  try {
    output = childProcess.execFileSync("codex", ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 16 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    throw new Error("Unable to detect the installed Codex CLI version. Ensure codex is available on PATH and codex --version succeeds, then restart the proxy.");
  }

  const match = /^codex-cli\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(output.trim());
  if (!match) {
    throw new Error("Unrecognized codex --version output. Expected codex-cli followed by a semantic version.");
  }
  return match[1];
}
