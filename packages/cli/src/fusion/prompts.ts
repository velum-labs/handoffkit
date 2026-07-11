/**
 * Default synthesizer prompts, pulled from the Python `fusionkit` CLI
 * (`fusionkit prompts dump`) so scaffolded `.fusionkit/prompts/*.md` files
 * match the engine's source of truth. Returns `undefined` when the CLI is
 * unreachable (e.g. offline) — callers fall back to leaving prompts unset, in
 * which case the built-in defaults are used at run time.
 */
import { superviseSpawn } from "@fusionkit/runtime-utils";

import { PROMPT_IDS } from "../fusion-config.js";
import type { PromptOverrides } from "../fusion-config.js";

import { fusionkitPyCommand } from "./env.js";

async function collectStdout(spawned: ReturnType<typeof superviseSpawn>): Promise<string> {
  const chunks: string[] = [];
  spawned.child.stdout?.on("data", (chunk: Buffer | string) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  });
  const exit = await spawned.done;
  if (exit.exitCode !== 0) throw new Error(`prompts dump exited ${exit.exitCode ?? "unknown"}`);
  return chunks.join("");
}

export async function fetchDefaultPrompts(fusionkitDir?: string): Promise<PromptOverrides | undefined> {
  const runner = fusionkitPyCommand(fusionkitDir);
  try {
    const spawned = superviseSpawn(runner.command, [...runner.prefix, "prompts", "dump"], {
      ...(runner.cwd !== undefined ? { cwd: runner.cwd } : {}),
      timeoutMs: 120_000
    });
    const stdout = await collectStdout(spawned);
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
