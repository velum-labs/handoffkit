import assert from "node:assert/strict";
import { test } from "node:test";

import { MODEL_FUSION_SCHEMA_BUNDLE_HASH } from "@warrant/protocol";
import type { ToolExecutionResult } from "@warrant/protocol";

import { handoff } from "../handoff.js";
import { HandoffToolJournal } from "../tool-journal.js";
import { targets } from "../targets.js";
import { localFirst } from "../policy.js";

function context(policy = localFirst()) {
  // No network traffic occurs until a checkpoint or continuation moves data,
  // so a dummy plane address is fine for pure tool/needs behavior.
  return handoff({
    workspace: ".",
    plane: { url: "http://127.0.0.1:9", adminToken: "unused" },
    policy
  });
}

test("h.tools wraps execute, preserves results, and journals calls", async () => {
  const h = context();
  const seen: unknown[] = [];
  const toolset = {
    add: {
      description: "adds two numbers",
      execute: async (input: { a: number; b: number }) => {
        seen.push(input);
        return { sum: input.a + input.b };
      }
    },
    schemaOnly: { description: "no execute; provider-executed" }
  };

  const wrapped = h.tools(toolset);
  assert.equal(wrapped.schemaOnly, toolset.schemaOnly, "tools without execute pass through");
  assert.equal(wrapped.add.description, "adds two numbers");

  const result = await wrapped.add.execute({ a: 2, b: 3 });
  assert.deepEqual(result, { sum: 5 });
  assert.deepEqual(seen, [{ a: 2, b: 3 }]);

  const events = h.trace().filter((e) => e.type === "tool.called");
  assert.equal(events.length, 1);
  const event = events[0];
  assert.ok(event && event.type === "tool.called");
  assert.equal(event.toolName, "add");
  assert.equal(event.ok, true);
  assert.match(event.inputHash, /^[0-9a-f]{64}$/);
  assert.match(event.outputHash ?? "", /^[0-9a-f]{64}$/);
});

test("h.tools journals failures and rethrows them", async () => {
  const h = context();
  const wrapped = h.tools({
    boom: {
      execute: async () => {
        throw new Error("tool exploded");
      }
    }
  });
  await assert.rejects(() => Promise.resolve(wrapped.boom.execute()), /tool exploded/);
  const events = h.trace().filter((e) => e.type === "tool.called");
  assert.equal(events.length, 1);
  const event = events[0];
  assert.ok(event && event.type === "tool.called");
  assert.equal(event.ok, false);
  assert.equal(event.outputHash, undefined);
});

test("h.needs is a pure policy check that records nothing", () => {
  const h = context(localFirst({ allowPools: ["eng-prod"] }));
  assert.equal(h.needs(targets.pool("eng-prod")), true);
  assert.equal(h.needs(targets.pool("untrusted")), false);
  assert.equal(h.trace().length, 0, "needs() must not pollute the trace");
});

test("h.summary recomputes counts from the trace", async () => {
  const h = context();
  const wrapped = h.tools({
    noop: { execute: async () => "ok" }
  });
  await wrapped.noop.execute();
  await wrapped.noop.execute();
  h.plan(targets.pool("anywhere"));

  const summary = await h.summary();
  assert.equal(summary.toolCalls, 2);
  assert.equal(summary.continuations.planned, 1);
  assert.equal(summary.continuations.denied, 0);
  assert.equal(summary.checkpoints, 0);
  assert.deepEqual(summary.runs, []);
});

test("tool journal can append ToolExecutor results without replacing existing wrapper", () => {
  const journal = new HandoffToolJournal();
  const result: ToolExecutionResult = {
    record: {
      schema: "tool-execution-record.v1",
      schema_version: "v1",
      schema_bundle_hash: MODEL_FUSION_SCHEMA_BUNDLE_HASH,
      producer: "test",
      producer_version: "0.1.0",
      producer_git_sha: "0".repeat(40),
      created_at: "2026-06-16T00:00:00.000Z",
      execution_id: "exec_read",
      plan_id: "plan_read",
      status: "succeeded",
      output_hash: "sha256:" + "a".repeat(64)
    },
    output: { ok: true },
    deduped: false,
    decision: { decision: "allow", reason: "test" }
  };
  journal.appendExecutionResult(result);
  assert.equal(journal.length, 1);
  assert.ok(journal.snapshot()?.hash.match(/^[0-9a-f]{64}$/));
});
