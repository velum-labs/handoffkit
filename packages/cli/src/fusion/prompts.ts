/**
 * Default synthesizer prompts, pulled from the Python `fusionkit` CLI
 * (`fusionkit prompts dump`) so scaffolded `.fusionkit/prompts/*.md` files
 * match the engine's source of truth. Returns `undefined` when the CLI is
 * unreachable (e.g. offline) — callers fall back to leaving prompts unset, in
 * which case the built-in defaults are used at run time.
 */
import { execFileSync } from "node:child_process";

import { PROMPT_IDS } from "../fusion-config.js";
import type { PromptOverrides } from "../fusion-config.js";

import { fusionkitPyCommand } from "./env.js";

export function fetchDefaultPrompts(fusionkitDir?: string): PromptOverrides | undefined {
  const runner = fusionkitPyCommand(fusionkitDir);
  try {
    const stdout = execFileSync(runner.command, [...runner.prefix, "prompts", "dump"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 120_000,
      ...(runner.cwd !== undefined ? { cwd: runner.cwd } : {})
    });
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const prompts: PromptOverrides = {};
    for (const id of PROMPT_IDS) {
      const value = parsed[id];
      if (typeof value === "string" && value.length > 0) prompts[id] = value;
    }
    return Object.keys(prompts).length > 0 ? prompts : undefined;
  } catch {
    return undefined;
  }
}
