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

  // Environment snapshot (including per-model provider).
  assert.equal(detail.environment?.repo, "/tmp/fusion-sample");
  assert.equal(detail.environment?.judgeModel, "gpt-5.5");
  assert.deepEqual(detail.environment?.harnesses, ["agent"]);
  assert.equal(detail.environment?.models?.length, 2);
  assert.equal(detail.environment?.models?.find((model) => model.id === "gpt")?.provider, "openai");

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

test("deriveSession surfaces the judge prompt and full panel prompts", () => {
  const mk = (partial: Omit<StoredEvent, "schema" | "trace_id">): StoredEvent => ({
    schema: "fusion-trace-event.v1",
    trace_id: "trace_prompts",
    ...partial
  });
  const events: StoredEvent[] = [
    mk({
      id: 1,
      span_id: "s_call",
      seq: 0,
      ts: 1,
      component: "panel-model",
      event_type: "model.call.started",
      candidate_id: "c1",
      model_id: "m1",
      payload: { model: "m1", system_prompt: "SYSTEM", prompt: "TASK", tools: ["run"] }
    }),
    mk({
      id: 2,
      span_id: "s_call",
      seq: 1,
      ts: 2,
      component: "panel-model",
      event_type: "model.call.finished",
      candidate_id: "c1",
      model_id: "m1",
      payload: { model: "m1", final_output: "DONE", finish_reason: "stop", latency_s: 0.1, usage: { total_tokens: 10 } }
    }),
    mk({
      id: 3,
      span_id: "s_judge",
      seq: 2,
      ts: 3,
      component: "judge",
      event_type: "judge.request",
      payload: {
        judge_model: "j",
        messages: [{ role: "user", content: "hi" }],
        trajectories: [{ trajectory_id: "c1" }],
        tools: [],
        trajectory_ids: ["c1"]
      }
    }),
    mk({
      id: 4,
      span_id: "s_judge",
      seq: 3,
      ts: 4,
      component: "judge",
      event_type: "judge.final",
      payload: { content: "FUSED", usage: { total_tokens: 7 } }
    })
  ];

  const detail = deriveSession("trace_prompts", events);
  const candidate = detail.candidates.find((entry) => entry.candidateId === "c1");
  assert.equal(candidate?.systemPrompt, "SYSTEM");
  assert.equal(candidate?.prompt, "TASK");
  assert.equal(candidate?.finalOutput, "DONE");
  assert.equal(detail.modelCalls.find((entry) => entry.candidateId === "c1")?.status, "succeeded");
  assert.equal(detail.judge.prompt?.judgeModel, "j");
  assert.deepEqual(detail.judge.prompt?.trajectoryIds, ["c1"]);
  assert.equal(detail.judge.final?.content, "FUSED");
  assert.match(detail.finalOutput ?? "", /FUSED/);
  // The full session prompt is recovered from the first model.call.started.
  assert.equal(detail.prompt, "TASK");
});

test("deriveSession recovers the session prompt from judge.request messages", () => {
  const mk = (partial: Omit<StoredEvent, "schema" | "trace_id">): StoredEvent => ({
    schema: "fusion-trace-event.v1",
    trace_id: "trace_judge_prompt",
    ...partial
  });
  const events: StoredEvent[] = [
    mk({
      id: 1,
      span_id: "j1",
      seq: 0,
      ts: 1,
      component: "judge",
      event_type: "judge.request",
      payload: {
        messages: [
          { role: "system", content: "SYS" },
          { role: "user", content: [{ type: "text", text: "USER PROMPT" }] }
        ],
        trajectories: []
      }
    })
  ];
  const detail = deriveSession("trace_judge_prompt", events);
  assert.equal(detail.prompt, "USER PROMPT");
});

test("deriveSession threads the turn through model calls", () => {
  const mk = (partial: Omit<StoredEvent, "schema" | "trace_id">): StoredEvent => ({
    schema: "fusion-trace-event.v1",
    trace_id: "trace_call_turns",
    ...partial
  });
  const events: StoredEvent[] = [
    mk({
      id: 1,
      span_id: "s1",
      seq: 0,
      ts: 1,
      component: "panel-model",
      event_type: "model.call.started",
      model_id: "m1",
      payload: { model: "m1", turn: 2 }
    }),
    mk({
      id: 2,
      span_id: "s1",
      seq: 1,
      ts: 2,
      component: "panel-model",
      event_type: "model.call.finished",
      model_id: "m1",
      payload: { model: "m1", turn: 2, latency_s: 0.1 }
    })
  ];
  const detail = deriveSession("trace_call_turns", events);
  assert.equal(detail.modelCalls[0]?.turn, 2);
});

test("deriveSession folds narration beats from gateway log events", () => {
  const mk = (partial: Omit<StoredEvent, "schema" | "trace_id">): StoredEvent => ({
    schema: "fusion-trace-event.v1",
    trace_id: "trace_narration",
    ...partial
  });
  const events: StoredEvent[] = [
    mk({
      id: 1,
      span_id: "n1",
      seq: 0,
      ts: 10,
      component: "gateway",
      event_type: "log",
      payload: { kind: "narration.beat", turn: 1, headline: "Fanning out to 2 models", prose: "x and y are racing." }
    }),
    mk({
      id: 2,
      span_id: "n2",
      seq: 1,
      ts: 20,
      component: "gateway",
      event_type: "log",
      payload: { kind: "narration.beat", turn: 1, headline: "Judging 2 candidates" }
    }),
    // Unrelated log events are ignored.
    mk({
      id: 3,
      span_id: "n3",
      seq: 2,
      ts: 30,
      component: "gateway",
      event_type: "log",
      payload: { kind: "cost.metered", model: "gpt-5.5" }
    })
  ];
  const detail = deriveSession("trace_narration", events);
  assert.equal(detail.narration.length, 2);
  assert.deepEqual(detail.narration[0], {
    ts: 10,
    turn: 1,
    headline: "Fanning out to 2 models",
    prose: "x and y are racing."
  });
  assert.deepEqual(detail.narration[1], { ts: 20, turn: 1, headline: "Judging 2 candidates" });
});

test("deriveSession preserves per-step judge history across turns", () => {
  const mk = (partial: Omit<StoredEvent, "schema" | "trace_id">): StoredEvent => ({
    schema: "fusion-trace-event.v1",
    trace_id: "trace_turns",
    ...partial
  });
  const events: StoredEvent[] = [
    mk({ id: 1, span_id: "j1", seq: 0, ts: 1, component: "judge", event_type: "judge.request", payload: { messages: [], trajectories: [], turn: 1 } }),
    mk({ id: 2, span_id: "j1", seq: 1, ts: 2, component: "judge", event_type: "judge.thinking", payload: { raw_analysis: "calling a tool", tool_calls: [{ id: "t" }], turn: 1 } }),
    mk({ id: 3, span_id: "j2", seq: 2, ts: 3, component: "judge", event_type: "judge.request", payload: { messages: [], trajectories: [], turn: 1 } }),
    mk({ id: 4, span_id: "j2", seq: 3, ts: 4, component: "judge", event_type: "judge.final", payload: { content: "answer one", turn: 1 } }),
    mk({ id: 5, span_id: "j3", seq: 4, ts: 5, component: "judge", event_type: "judge.request", payload: { messages: [], trajectories: [], turn: 2 } }),
    mk({ id: 6, span_id: "j3", seq: 5, ts: 6, component: "judge", event_type: "judge.final", payload: { content: "answer two", turn: 2 } })
  ];

  const detail = deriveSession("trace_turns", events);
  assert.equal(detail.judgeSteps.length, 3);
  assert.equal(detail.judgeSteps[0].kind, "intermediate");
  assert.equal(detail.judgeSteps[0].turn, 1);
  assert.equal(detail.judgeSteps[1].kind, "final");
  assert.equal(detail.judgeSteps[1].final?.content, "answer one");
  assert.equal(detail.judgeSteps[2].turn, 2);
  assert.equal(detail.judgeSteps[2].final?.content, "answer two");
  // The last-wins summary still reflects the most recent turn.
  assert.match(detail.finalOutput ?? "", /answer two/);
});

test("deriveSession attributes candidates to their user turn", () => {
  const mk = (partial: Omit<StoredEvent, "schema" | "trace_id">): StoredEvent => ({
    schema: "fusion-trace-event.v1",
    trace_id: "trace_cand_turns",
    ...partial
  });
  const events: StoredEvent[] = [
    mk({ id: 1, span_id: "c1", seq: 0, ts: 1, component: "panel-model", event_type: "harness.candidate.started", candidate_id: "t1_gpt", model_id: "gpt", payload: { model: "gpt", turn: 1 } }),
    mk({ id: 2, span_id: "c2", seq: 1, ts: 2, component: "panel-model", event_type: "harness.candidate.started", candidate_id: "t2_gpt", model_id: "gpt", payload: { model: "gpt", turn: 2 } })
  ];

  const detail = deriveSession("trace_cand_turns", events);
  assert.equal(detail.candidates.find((c) => c.candidateId === "t1_gpt")?.turn, 1);
  assert.equal(detail.candidates.find((c) => c.candidateId === "t2_gpt")?.turn, 2);
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
