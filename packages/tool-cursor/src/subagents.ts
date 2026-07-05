/**
 * OOTB Cursor sub-agents: one `.cursor/agents/fusion-<name>.md` per fusion
 * ensemble, so Cursor's Task tool (CLI and IDE) can delegate to any ensemble by
 * name. Unlike the Codex/Claude launchers (whose sub-agent definitions live in
 * ephemeral session config), Cursor only reads agent files from the repo/user
 * agents directories — so these are real, commit-worthy files. Existing files
 * are never overwritten (user edits win).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { deriveFusedSubagents } from "@fusionkit/tools";
import type { FusedEnsembleInfo } from "@fusionkit/tools";

/** The repo-scoped Cursor agents directory. */
export const CURSOR_AGENTS_DIRNAME = join(".cursor", "agents");

/** The agent file contents for one ensemble (YAML frontmatter + prompt). */
export function cursorSubagentMarkdown(ensemble: FusedEnsembleInfo, isDefault: boolean): string {
  const subagent = deriveFusedSubagents(
    [ensemble],
    isDefault ? ensemble.modelId : "",
    "delegate-task"
  )[0];
  if (subagent === undefined) throw new Error("missing fused sub-agent definition");
  return [
    "---",
    `name: ${ensemble.modelId}`,
    `description: ${subagent.description}`,
    `model: ${ensemble.modelId}`,
    "---",
    "",
    subagent.developerInstructions,
    ""
  ].join("\n");
}

/**
 * Write one agent file per ensemble into `<repo>/.cursor/agents/`. Idempotent:
 * an existing file is left untouched. Returns the paths actually written.
 * Best-effort — a read-only checkout must never fail the launch.
 */
export function scaffoldCursorSubagents(
  repo: string,
  ensembles: readonly FusedEnsembleInfo[],
  options: { defaultModelId?: string; log?: (line: string) => void } = {}
): string[] {
  const written: string[] = [];
  try {
    const dir = join(repo, CURSOR_AGENTS_DIRNAME);
    mkdirSync(dir, { recursive: true });
    for (const ensemble of ensembles) {
      const path = join(dir, `${ensemble.modelId}.md`);
      if (existsSync(path)) continue;
      writeFileSync(
        path,
        cursorSubagentMarkdown(ensemble, ensemble.modelId === options.defaultModelId)
      );
      written.push(path);
    }
  } catch (error) {
    options.log?.(
      `fusion: could not scaffold .cursor/agents sub-agents (${error instanceof Error ? error.message : String(error)})`
    );
    return written;
  }
  if (written.length > 0) {
    options.log?.(
      `fusion: scaffolded ${written.length} ensemble sub-agent(s) in ${join(repo, CURSOR_AGENTS_DIRNAME)} (commit them to keep; --no-subagents to skip)`
    );
  }
  return written;
}
