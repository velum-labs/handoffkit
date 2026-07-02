import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Point the collector at a throwaway DB before importing it (db() caches the
// handle on first use, keyed off this env var).
process.env.SCOPEKIT_DB = join(mkdtempSync(join(tmpdir(), "scope-collector-")), "scope.db");

const { ingestEvent, getEvents, listSessions, getSession, eventsByType } = await import("../lib/db");
const { deriveSession } = await import("../lib/sessions");
const { rollupModels } = await import("../lib/rollups");
const { syntheticSession } = await import("./fixture");

test("ingest + query round-trips a full session and derives detail", () => {
  const events = syntheticSession("trace_rt");
  let accepted = 0;
  for (const event of events) {
    if (ingestEvent(event)) accepted += 1;
  }
  assert.equal(accepted, events.length);

  // Idempotent by content hash: re-ingesting changes nothing.
  for (const event of events) assert.equal(ingestEvent(event), false);

  const stored = getEvents("trace_rt");
  assert.equal(stored.length, events.length);

  const session = getSession("trace_rt");
  assert.ok(session);
  assert.equal(session.status, "succeeded");
  assert.equal(session.repo, "/tmp/fusion-sample");
  assert.equal(session.prompt_preview, "Fix the add() sign bug so npm test passes.");
  assert.equal(session.event_count, events.length);

  const detail = deriveSession("trace_rt", stored);
  assert.equal(detail.candidates.length, 2);
  assert.equal(detail.judge.final?.decision, "synthesize");

  const rows = listSessions();
  assert.ok(rows.some((row) => row.trace_id === "trace_rt"));

  const calls = eventsByType(["model.call.started", "model.call.finished"]);
  const rollup = rollupModels(calls);
  const gpt = rollup.find((entry) => entry.modelId === "gpt");
  assert.ok(gpt);
  assert.equal(gpt.succeeded, 1);
  assert.equal(gpt.totalTokens, 920);
  assert.equal(gpt.promptTokens, 800);
  assert.equal(gpt.completionTokens, 120);
});
