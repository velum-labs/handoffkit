/**
 * WS10 acceptance: session-store locking, turns compaction, random session
 * identity (content hash demoted to a resume hint), and awaited persistence.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  FusionSessionManager,
  InMemoryFusionBackendKernelStateStore,
  PendingSessionWrites
} from "../fusion-session.js";
import { defaultFusionGatewayLogger } from "../logger.js";
import { FileSystemSessionStore, InMemorySessionStore } from "../session-store.js";
import type { SessionMeta, SessionTurnRecord } from "../session-store.js";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fusionkit-session-ws10-"));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function meta(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    traceId: `trace_${id}`,
    sessionSpan: `span_${id}`,
    createdAt: 1000,
    updatedAt: 1000,
    ...extra
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

function manager(store?: InMemorySessionStore | FileSystemSessionStore): FusionSessionManager {
  return new FusionSessionManager({
    ttlMs: 60_000,
    runPanels: async () => [],
    mintTraceId: () => "trace",
    kernelStateStore: new InMemoryFusionBackendKernelStateStore(),
    ...(store !== undefined ? { store } : {}),
    sessionMeta: {},
    logger: defaultFusionGatewayLogger
  });
}

const opener = [
  { role: "system", content: "be useful" },
  { role: "user", content: "build the thing" }
];
const continuing = [...opener, { role: "assistant", content: "on it" }, { role: "user", content: "continue" }];

// ---- locking ----------------------------------------------------------------

test("concurrent mutators from separate store instances never lose meta fields", async () => {
  const root = tempDir();
  // Two store instances = two independent in-process mutexes, so only the
  // cross-process lockfile serializes them (the multi-writer scenario).
  const a = new FileSystemSessionStore(root);
  const b = new FileSystemSessionStore(root);
  await a.saveMeta(meta("shared"));

  const writes: Array<Promise<void>> = [];
  for (let index = 1; index <= 8; index += 1) {
    writes.push(a.appendTurn("shared", turn(index)));
    writes.push(
      b.recordCost("shared", {
        totalUsd: index,
        providerUsd: index,
        localComputeUsd: 0,
        localActiveMs: 0,
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
        meteredTurns: index,
        unknownCostTurns: 0,
        meteredEntries: index,
        unknownCostEntries: 0,
        currency: "USD"
      })
    );
  }
  await Promise.all(writes);

  const loaded = new FileSystemSessionStore(root).load("shared");
  assert.ok(loaded !== undefined);
  // The read-modify-write interleave hazard: without locking, an updatedAt
  // bump routinely erases the cost rollup (or vice versa). Both must survive.
  assert.equal(loaded.turns.length, 8, "every appended turn survived");
  assert.ok(loaded.meta.cost !== undefined, "the cost rollup survived concurrent meta bumps");
  assert.equal(loaded.meta.updatedAt, 1008, "the last-activity bump survived concurrent cost writes");
});

test("in-process mutations of one session are serialized (no torn meta)", async () => {
  const root = tempDir();
  const store = new FileSystemSessionStore(root);
  await store.saveMeta(meta("solo"));
  await Promise.all(Array.from({ length: 12 }, (_, index) => store.appendTurn("solo", turn(index + 1))));
  const loaded = store.load("solo");
  assert.equal(loaded?.turns.length, 12);
  assert.equal(loaded?.meta.updatedAt, 1012);
});

// ---- compaction -------------------------------------------------------------

test("turns.jsonl compacts to a deduped snapshot once it crosses the threshold", async () => {
  const root = tempDir();
  const store = new FileSystemSessionStore(root, { compactAfterLines: 4 });
  await store.saveMeta(meta("fat"));
  // Re-record the same two turns repeatedly (the finite-k re-fuse pattern).
  for (let round = 0; round < 6; round += 1) {
    await store.appendTurn("fat", turn(1));
    await store.appendTurn("fat", turn(2));
  }
  const raw = readFileSync(join(root, "fat", "turns.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  assert.ok(raw.length <= 4, `compaction bounded the log (got ${raw.length} lines)`);

  const loaded = store.load("fat");
  assert.deepEqual(loaded?.turns.map((entry) => entry.turn), [1, 2], "last-write-wins snapshot kept both turns");
});

// ---- identity ---------------------------------------------------------------

test("two conversations with an identical opener get distinct session ids", () => {
  const sessions = manager(new InMemorySessionStore());
  const first = sessions.resolveSessionId(opener);
  // The first conversation is still live: the same opener resolves to it
  // (turn-2 lookups and client retries depend on this).
  assert.equal(sessions.resolveSessionId(opener), first);

  // A different process starting the same opener is a *new* conversation.
  const other = manager(new InMemorySessionStore());
  const second = other.resolveSessionId(opener);
  assert.notEqual(second, first, "identical openers must not share identity across conversations");
});

test("session ids are random tokens, not the conversation content hash", () => {
  const sessions = manager();
  const id = sessions.resolveSessionId(opener);
  assert.notEqual(id, sessions.sessionKey(opener), "the id is minted, not derived from content");
});

test("a continuing conversation reattaches to its persisted session after a restart", async () => {
  const store = new InMemorySessionStore();
  const before = manager(store);
  const id = before.resolveSessionId(opener);
  before.ensureSession(id);
  await before.flush();
  assert.equal(store.list()[0]?.contentHint, before.sessionKey(opener), "the header carries the resume hint");

  // Gateway restart: a fresh manager sees turn 2 of the same conversation.
  const afterRestart = manager(store);
  assert.equal(afterRestart.resolveSessionId(continuing), id, "the continuing conversation found its session");

  // But a fresh opener (no assistant turns) must NOT reattach to history.
  const freshStart = manager(store);
  assert.notEqual(freshStart.resolveSessionId(opener), id, "a new conversation never adopts an old identity");
});

// ---- awaited persistence ----------------------------------------------------

test("flush waits for the tail of detached writes, including chained ones", async () => {
  const pending = new PendingSessionWrites();
  const settled: string[] = [];
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  pending.track(
    first.then(() => {
      settled.push("first");
      // A write completing can enqueue a follow-up (meta bump after a turn).
      pending.track(Promise.resolve().then(() => settled.push("second")));
    })
  );

  const flushed = pending.flush().then(() => settled.push("flush"));
  releaseFirst();
  await flushed;
  assert.deepEqual(settled, ["first", "second", "flush"], "flush resolved only after every chained write");
});

test("flush survives rejected writes (error handling stays with the writer)", async () => {
  const pending = new PendingSessionWrites();
  pending.track(Promise.reject(new Error("disk full")));
  await pending.flush();
});
