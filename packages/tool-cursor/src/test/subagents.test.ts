import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import type { AgentProfile } from "@routekit/tools";

import {
  CURSOR_AGENTS_DIRNAME,
  cursorSubagentMarkdown,
  scaffoldCursorSubagents
} from "../subagents.js";

const PROFILES: readonly AgentProfile[] = [
  {
    id: "reviewer",
    model: "opaque-model",
    description: "Review changes.",
    instructions: "Return findings."
  },
  {
    id: "implementer",
    model: "other-model",
    description: "Implement changes.",
    instructions: "Make the requested change."
  }
];

const tmpRoots: string[] = [];
function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cursor-subagents-"));
  tmpRoots.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

test("cursorSubagentMarkdown serializes a generic profile", () => {
  const md = cursorSubagentMarkdown(PROFILES[0] as AgentProfile);
  assert.match(md, /name: reviewer/);
  assert.match(md, /model: opaque-model/);
  assert.match(md, /Return findings/);
});

test("scaffoldCursorSubagents writes profiles and never overwrites", () => {
  const repo = freshRepo();
  assert.equal(scaffoldCursorSubagents(repo, PROFILES).length, 2);
  const path = join(repo, CURSOR_AGENTS_DIRNAME, "reviewer.md");
  assert.ok(existsSync(path));
  writeFileSync(path, "USER EDIT\n");
  assert.deepEqual(scaffoldCursorSubagents(repo, PROFILES), []);
  assert.equal(readFileSync(path, "utf8"), "USER EDIT\n");
});

test("scaffoldCursorSubagents is best-effort", () => {
  const repo = freshRepo();
  writeFileSync(join(repo, ".cursor"), "not a directory");
  const lines: string[] = [];
  assert.deepEqual(scaffoldCursorSubagents(repo, PROFILES, (line) => lines.push(line)), []);
  assert.equal(lines.length, 1);
});
