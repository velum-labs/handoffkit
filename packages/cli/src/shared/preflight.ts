import { execFileSync } from "node:child_process";

/** Thrown when the environment is missing a binary or credential fusion needs. */
export class PreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreflightError";
  }
}

/** True when `bin` resolves on PATH. */
export function hasBinary(bin: string): boolean {
  const finder = process.platform === "win32" ? "where" : "which";
  try {
    execFileSync(finder, [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export const INSTALL_HINTS: Record<string, string> = {
  uv: "install uv: https://docs.astral.sh/uv/getting-started/installation/",
  uvx: "install uv (ships uvx): https://docs.astral.sh/uv/getting-started/installation/",
  codex: "install the Codex CLI: https://github.com/openai/codex",
  claude: "install Claude Code: https://docs.anthropic.com/en/docs/claude-code/overview",
  "cursor-agent": "install the Cursor CLI: https://cursor.com/cli"
};

/**
 * Fail fast with actionable guidance when a required binary or API key is
 * missing. Keeps "minimal setup" honest: clear errors instead of deep stack
 * traces from a half-started stack.
 */
export function runPreflight(input: { requiredBins: string[]; requiredEnv: string[] }): void {
  const problems: string[] = [];
  for (const bin of input.requiredBins) {
    if (!hasBinary(bin)) {
      problems.push(`  - "${bin}" was not found on PATH — ${INSTALL_HINTS[bin] ?? `install ${bin}`}`);
    }
  }
  for (const env of [...new Set(input.requiredEnv)]) {
    const value = process.env[env];
    if (value === undefined || value.length === 0) {
      problems.push(`  - ${env} is not set — required by the selected panel (export it, or pass --model/--key-env)`);
    }
  }
  if (problems.length > 0) {
    throw new PreflightError(`fusionkit preflight failed:\n${problems.join("\n")}`);
  }
}
