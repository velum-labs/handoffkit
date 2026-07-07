import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { CURSOR_AGENTS_DIRNAME, cursorSubagentMarkdown, scaffoldCursorSubagents } from "../subagents.js";

const ENSEMBLES = [
  { name: "default", modelId: "fusion-panel", memberIds: ["kimi", "qwen3"] },
  { name: "deep", modelId: "fusion-deep", memberIds: ["opus"] }
] as const;

const tmpRoots: string[] = [];
function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cursor-subagents-"));
  tmpRoots.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

test("cursorSubagentMarkdown pins the agent to the ensemble's model id", () => {
  const md = cursorSubagentMarkdown(
    { name: "deep", modelId: "fusion-deep", memberIds: ["opus", "gpt"] },
    false
  );
  assert.match(md, /^---\n/);
  assert.match(md, /name: fusion-deep/);
  assert.match(md, /model: fusion-deep/);
  assert.match(md, /"deep" fusion ensemble \(opus, gpt/);
  assert.match(md, /panel-and-judge fusion/);
});

test("scaffoldCursorSubagents writes one file per ensemble into .cursor/agents", () => {
  const repo = freshRepo();
  const written = scaffoldCursorSubagents(repo, ENSEMBLES, { defaultModelId: "fusion-panel" });
  assert.equal(written.length, 2);
  const deepPath = join(repo, CURSOR_AGENTS_DIRNAME, "fusion-deep.md");
  assert.ok(existsSync(deepPath));
  assert.match(readFileSync(deepPath, "utf8"), /model: fusion-deep/);
  // The default ensemble's description says so.
  const defaultPath = join(repo, CURSOR_AGENTS_DIRNAME, "fusion-panel.md");
  assert.match(readFileSync(defaultPath, "utf8"), /default "default" fusion ensemble/);
});

test("scaffoldCursorSubagents never overwrites an existing agent file", () => {
  const repo = freshRepo();
  scaffoldCursorSubagents(repo, ENSEMBLES, { defaultModelId: "fusion-panel" });
  const deepPath = join(repo, CURSOR_AGENTS_DIRNAME, "fusion-deep.md");
  writeFileSync(deepPath, "USER EDIT\n");
  const written = scaffoldCursorSubagents(repo, ENSEMBLES, { defaultModelId: "fusion-panel" });
  assert.deepEqual(written, [], "second run writes nothing");
  assert.equal(readFileSync(deepPath, "utf8"), "USER EDIT\n", "user edits win");
});

test("scaffoldCursorSubagents is best-effort on an unwritable repo", () => {
  const repo = freshRepo();
  // A file where the .cursor directory should be makes mkdir fail.
  writeFileSync(join(repo, ".cursor"), "not a directory");
  const lines: string[] = [];
  const written = scaffoldCursorSubagents(repo, ENSEMBLES, { log: (line) => lines.push(line) });
  assert.deepEqual(written, []);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /could not scaffold/);
});
