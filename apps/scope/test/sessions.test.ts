import assert from "node:assert/strict";
import { test } from "node:test";

import { deriveSession } from "../lib/sessions";
import type { StoredEvent } from "../lib/types";
import { syntheticSession } from "./fixture";

function stored(): StoredEvent[] {
  return syntheticSession("trace_derive").map((event, index) => ({ ...event, id: index + 1 }));
}

test("deriveSession folds a full session into structured detail", () => {
  const detail = deriveSession("trace_derive", stored());

  assert.equal(detail.traceId, "trace_derive");
  assert.equal(detail.status, "succeeded");
  assert.equal(detail.dialect, "codex");

  // Environment snapshot.
  assert.equal(detail.environment?.repo, "/tmp/fusion-sample");
  assert.equal(detail.environment?.judgeModel, "gpt-5.5");
  assert.deepEqual(detail.environment?.harnesses, ["agent"]);
  assert.equal(detail.environment?.models?.length, 2);

  // Candidates with ordered trajectory steps.
  assert.equal(detail.candidates.length, 2);
  const gpt = detail.candidates.find((candidate) => candidate.candidateId === "cand_gpt");
  assert.ok(gpt);
  assert.equal(gpt.status, "succeeded");
  assert.equal(gpt.verificationStatus, "passed");
  assert.deepEqual(
    gpt.steps.map((step) => step.index),
    [0, 1, 2]
  );
  assert.equal(gpt.steps[0].type, "reasoning");
  assert.equal(gpt.steps[1].tool_name, "apply_patch");

  // Paired model call resolves to succeeded with usage + latency.
  const call = detail.modelCalls.find((entry) => entry.candidateId === "cand_gpt");
  assert.ok(call);
  assert.equal(call.status, "succeeded");
  assert.equal(call.latencyS, 0.35);
  assert.equal((call.usage as { total_tokens?: number }).total_tokens, 920);

  // Judge thinking -> scored -> synthesis -> final.
  assert.match(detail.judge.thinking?.raw ?? "", /regression test/);
  assert.equal(detail.judge.scored?.inputIds?.length, 2);
  assert.equal(detail.judge.synthesis?.empty, false);
  assert.equal(detail.judge.final?.decision, "synthesize");
  assert.match(detail.finalOutput ?? "", /left \+ right/);

  // Event counts + ordering.
  assert.equal(detail.eventCounts["trajectory.step"], 5);
  assert.ok(detail.durationMs > 0);
});

test("deriveSession is resilient to a partial (still-running) session", () => {
  const events = syntheticSession("trace_partial")
    .filter((event) => event.event_type !== "session.finished" && !event.event_type.startsWith("judge"))
    .map((event, index) => ({ ...event, id: index + 1 }));

  const detail = deriveSession("trace_partial", events);
  assert.equal(detail.status, "running");
  assert.equal(detail.judge.final, undefined);
  assert.ok(detail.candidates.length >= 1);
});
