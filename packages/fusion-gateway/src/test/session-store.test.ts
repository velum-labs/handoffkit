import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  defaultSessionsDir,
  FileSystemSessionStore,
  InMemorySessionStore
} from "../session-store.js";
import type { CostLedgerEntry } from "../cost.js";
import type { SessionMeta, SessionTurnRecord } from "../session-store.js";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fusionkit-sessions-store-"));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function meta(id: string): SessionMeta {
  return {
    id,
    tool: "codex",
    repo: "/repo",
    models: [
      { id: "gpt", model: "gpt-5.5" },
      { id: "sonnet", model: "claude-sonnet-4-6" }
    ],
    judgeModel: "gpt-5.5",
    defaultModel: "fusion-panel",
    traceId: `trace_${id}`,
    sessionSpan: `span_${id}`,
    createdAt: 1000,
    updatedAt: 1000
  };
}

function turn(index: number): SessionTurnRecord {
  return {
    turn: index,
    messages: [{ role: "user", content: `task ${index}` }],
    candidates: [{ trajectory_id: `t${index}`, model_id: "gpt", status: "succeeded", final_output: "ok" }],
    recordedAt: 1000 + index
  };
}

function costEntry(stage: CostLedgerEntry["stage"]): CostLedgerEntry {
  return {
    entryId: `cost_${stage}`,
    stage,
    recordedAt: 1100,
    model: "gpt-5.5",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    costUsd: 0.001,
    providerCostUsd: 0.001,
    unknownUsage: false,
    unknownCost: false,
    currency: "USD"
  };
}

test("round-trips a session through a fresh store instance (persist → reload)", async () => {
  const root = tempDir();
  const writer = new FileSystemSessionStore(root);
  await writer.saveMeta(meta("alpha"));
  await writer.appendTurn("alpha", turn(1));
  await writer.appendTurn("alpha", turn(2));

  // A brand-new instance (simulating a new CLI process) reads it back.
  const reader = new FileSystemSessionStore(root);
  const loaded = reader.load("alpha");
  assert.ok(loaded !== undefined);
  assert.equal(loaded.meta.id, "alpha");
  assert.equal(loaded.meta.tool, "codex");
  assert.equal(loaded.meta.traceId, "trace_alpha");
  assert.deepEqual(loaded.turns.map((entry) => entry.turn), [1, 2]);
  assert.equal(loaded.turns[1]?.candidates[0]?.trajectory_id, "t2");
  // appendTurn bumps last-activity but never the creation time.
  assert.equal(loaded.meta.createdAt, 1000);
  assert.equal(loaded.meta.updatedAt, 1002);
});

test("list summarizes sessions, most-recently-active first, with turn counts", async () => {
  const root = tempDir();
  const store = new FileSystemSessionStore(root);
  await store.saveMeta(meta("older"));
  await store.appendTurn("older", turn(1));
  await store.saveMeta(meta("newer"));
  await store.appendTurn("newer", turn(1));
  await store.appendTurn("newer", turn(2));

  const list = store.list();
  assert.deepEqual(list.map((entry) => entry.id), ["newer", "older"]);
  assert.equal(list[0]?.turnCount, 2);
  assert.equal(list[1]?.turnCount, 1);
});

test("cost ledger entries persist beside the running summary", async () => {
  const root = tempDir();
  const writer = new FileSystemSessionStore(root);
  await writer.saveMeta(meta("costed"));
  await writer.recordCostEntry("costed", costEntry("panel"), {
    totalUsd: 0.001,
    providerUsd: 0.001,
    localComputeUsd: 0,
    localActiveMs: 0,
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    meteredTurns: 1,
    unknownCostTurns: 0,
    meteredEntries: 1,
    unknownCostEntries: 0,
    currency: "USD"
  });

  const loaded = new FileSystemSessionStore(root).load("costed");
  assert.equal(loaded?.meta.cost?.totalUsd, 0.001);
  assert.equal(loaded?.costLedger.length, 1);
  assert.equal(loaded?.costLedger[0]?.stage, "panel");
});

test("remove deletes a session and is idempotent", async () => {
  const root = tempDir();
  const store = new FileSystemSessionStore(root);
  await store.saveMeta(meta("gone"));
  assert.equal(store.remove("gone"), true);
  assert.equal(store.load("gone"), undefined);
  assert.equal(store.remove("gone"), false);
});

test("load returns undefined for an unknown id and an empty list on a missing root", () => {
  const store = new FileSystemSessionStore(join(tempDir(), "does-not-exist"));
  assert.equal(store.load("nope"), undefined);
  assert.deepEqual(store.list(), []);
});

test("a torn trailing turn line is skipped, not fatal", async () => {
  const root = tempDir();
  const store = new FileSystemSessionStore(root);
  await store.saveMeta(meta("torn"));
  await store.appendTurn("torn", turn(1));
  // Simulate a crash mid-write by appending a partial JSON line.
  appendFileSync(join(root, "torn", "turns.jsonl"), '{"turn":2,"messa', "utf8");
  const loaded = store.load("torn");
  assert.ok(loaded !== undefined);
  assert.deepEqual(loaded.turns.map((entry) => entry.turn), [1]);
});

test("the in-memory store mirrors the filesystem store's contract", async () => {
  const store = new InMemorySessionStore();
  await store.saveMeta(meta("mem"));
  await store.appendTurn("mem", turn(1));
  await store.appendTurn("mem", turn(2));
  const loaded = store.load("mem");
  assert.deepEqual(loaded?.turns.map((entry) => entry.turn), [1, 2]);
  assert.equal(store.list()[0]?.turnCount, 2);
  assert.equal(store.remove("mem"), true);
  assert.equal(store.load("mem"), undefined);
});

test("defaultSessionsDir honors FUSIONKIT_SESSIONS_DIR", () => {
  const previous = process.env.FUSIONKIT_SESSIONS_DIR;
  try {
    process.env.FUSIONKIT_SESSIONS_DIR = "/tmp/custom-sessions";
    assert.equal(defaultSessionsDir(), "/tmp/custom-sessions");
    delete process.env.FUSIONKIT_SESSIONS_DIR;
    assert.match(defaultSessionsDir(), /\.fusionkit\/sessions$/);
  } finally {
    if (previous === undefined) delete process.env.FUSIONKIT_SESSIONS_DIR;
    else process.env.FUSIONKIT_SESSIONS_DIR = previous;
  }
});
