import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentProfile } from "@velum-labs/routekit-tools";

export const CURSOR_AGENTS_DIRNAME = join(".cursor", "agents");

export function cursorSubagentMarkdown(profile: AgentProfile): string {
  return [
    "---",
    `name: ${profile.id}`,
    `description: ${profile.description}`,
    `model: ${profile.model}`,
    "---",
    "",
    profile.instructions,
    ""
  ].join("\n");
}

export function scaffoldCursorSubagents(
  repo: string,
  profiles: readonly AgentProfile[],
  log?: (line: string) => void
): string[] {
  const written: string[] = [];
  try {
    const dir = join(repo, CURSOR_AGENTS_DIRNAME);
    mkdirSync(dir, { recursive: true });
    for (const profile of profiles) {
      const path = join(dir, `${profile.id}.md`);
      if (existsSync(path)) continue;
      writeFileSync(path, cursorSubagentMarkdown(profile));
      written.push(path);
    }
  } catch (error) {
    log?.(`could not scaffold Cursor agents (${error instanceof Error ? error.message : String(error)})`);
  }
  return written;
}
