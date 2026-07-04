import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const CLI = fileURLToPath(new URL("../index.js", import.meta.url));

const tempDirs: string[] = [];
function sessionsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fusionkit-sessions-cli-"));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Write a session into a sessions root the same way the gateway store would. */
function seedSession(
  root: string,
  id: string,
  meta: Record<string, unknown>,
  turns: Array<Record<string, unknown>>
): void {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ id, ...meta }), "utf8");
  writeFileSync(join(dir, "turns.jsonl"), turns.map((turn) => JSON.stringify(turn)).join("\n") + "\n", "utf8");
}

function runCli(args: string[], sessionsRoot: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, FUSIONKIT_SESSIONS_DIR: sessionsRoot, NO_COLOR: "1", FUSIONKIT_NO_TUI: "1" }
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function baseMeta(tool: string, updatedAt: number): Record<string, unknown> {
  return {
    tool,
    repo: "/work/repo",
    models: [
      { id: "gpt", model: "gpt-5.5" },
      { id: "sonnet", model: "claude-sonnet-4-6" }
    ],
    judgeModel: "gpt-5.5",
    defaultModel: "fusion-panel",
    traceId: "trace_x",
    sessionSpan: "span_x",
    createdAt: 1000,
    updatedAt
  };
}

function turn(index: number): Record<string, unknown> {
  return {
    turn: index,
    messages: [{ role: "user", content: `task number ${index}` }],
    candidates: [{ trajectory_id: `t${index}`, model_id: "gpt", status: "succeeded", final_output: "ok" }],
    recordedAt: 1000 + index
  };
}

test("`sessions list` shows nothing in an empty store", () => {
  const root = sessionsDir();
  const { status, stderr: out } = runCli(["sessions", "list"], root);
  assert.equal(status, 0);
  assert.match(out, /no sessions yet/);
});

test("`sessions list` shows id, tool, panel, turn count, most-recent first", () => {
  const root = sessionsDir();
  seedSession(root, "1111aaaa2222bbbb", baseMeta("codex", Date.now() - 10_000), [turn(1)]);
  seedSession(root, "3333cccc4444dddd", baseMeta("claude", Date.now()), [turn(1), turn(2)]);
  const { status, stderr: out } = runCli(["sessions", "list"], root);
  assert.equal(status, 0);
  assert.match(out, /1111aaaa2222bbbb/);
  assert.match(out, /3333cccc4444dddd/);
  assert.match(out, /codex/);
  assert.match(out, /claude/);
  assert.match(out, /gpt\+sonnet/);
  assert.match(out, /2 turns/);
  // Most-recently-active session is listed first.
  assert.ok(out.indexOf("3333cccc4444dddd") < out.indexOf("1111aaaa2222bbbb"));
});

test("bare `sessions` defaults to listing", () => {
  const root = sessionsDir();
  seedSession(root, "abcd1234abcd1234", baseMeta("codex", Date.now()), [turn(1)]);
  const { status, stderr: out } = runCli(["sessions"], root);
  assert.equal(status, 0);
  assert.match(out, /abcd1234abcd1234/);
});

test("`sessions show` resolves a unique prefix and prints details + recent turns", () => {
  const root = sessionsDir();
  seedSession(root, "deadbeefdeadbeef", baseMeta("codex", Date.now()), [turn(1), turn(2)]);
  const { status, stderr: out } = runCli(["sessions", "show", "deadbeef"], root);
  assert.equal(status, 0);
  assert.match(out, /deadbeefdeadbeef/);
  assert.match(out, /codex/);
  assert.match(out, /gpt=gpt-5\.5/);
  assert.match(out, /recent turns/);
  assert.match(out, /turn 2/);
  assert.match(out, /task number 2/);
});

test("`sessions show` fails for an unknown id", () => {
  const root = sessionsDir();
  const { status, stderr } = runCli(["sessions", "show", "nope"], root);
  assert.equal(status, 1);
  assert.match(stderr, /no session matches/);
});

test("`sessions rm` deletes a session by prefix", () => {
  const root = sessionsDir();
  seedSession(root, "feedface00000000", baseMeta("codex", Date.now()), [turn(1)]);
  const removed = runCli(["sessions", "rm", "feedface"], root);
  assert.equal(removed.status, 0);
  assert.match(removed.stderr, /removed session/);
  // It is gone from the listing afterwards.
  const list = runCli(["sessions", "list"], root);
  assert.match(list.stderr, /no sessions yet/);
});
