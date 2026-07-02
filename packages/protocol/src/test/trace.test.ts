import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertFusionTraceEvent,
  FUSION_TRACE_EVENT_SCHEMA,
  isFusionTraceEvent,
  judgeFinalPayload,
  judgeRequestPayload,
  judgeThinkingPayload,
  modelCallFinishedPayload,
  modelCallStartedPayload,
  TraceEmitter
} from "../trace.js";
import type { FusionTraceEvent } from "../trace.js";

function validEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: FUSION_TRACE_EVENT_SCHEMA,
    trace_id: "trace_x",
    span_id: "span_x",
    seq: 0,
    ts: Date.now(),
    component: "judge",
    event_type: "judge.request",
    ...overrides
  };
}

test("assertFusionTraceEvent accepts a well-formed event", () => {
  assert.doesNotThrow(() => assertFusionTraceEvent(validEvent()));
  assert.equal(isFusionTraceEvent(validEvent()), true);
});

test("assertFusionTraceEvent rejects malformed events", () => {
  assert.throws(() => assertFusionTraceEvent(null));
  assert.throws(() => assertFusionTraceEvent(validEvent({ schema: "nope" })));
  assert.throws(() => assertFusionTraceEvent(validEvent({ component: "martian" })));
  assert.throws(() => assertFusionTraceEvent(validEvent({ event_type: "nope" })));
  assert.throws(() => assertFusionTraceEvent(validEvent({ trace_id: "" })));
  assert.throws(() => assertFusionTraceEvent(validEvent({ seq: "x" })));
  assert.throws(() => assertFusionTraceEvent(validEvent({ payload: [] })));
  assert.equal(isFusionTraceEvent(validEvent({ component: "x" })), false);
});

test("judgeRequestPayload carries the full prompt fields and the turn", () => {
  const payload = judgeRequestPayload({
    judgeModel: "j",
    messages: [{ role: "user" }],
    trajectories: [{ trajectory_id: "t" }],
    tools: [],
    trajectoryIds: ["t"],
    turn: 2
  });
  assert.equal(payload.judge_model, "j");
  assert.deepEqual(payload.trajectory_ids, ["t"]);
  assert.equal(payload.turn, 2);
  assert.ok(Array.isArray(payload.messages));
  assert.ok(Array.isArray(payload.trajectories));
});

test("judgeThinkingPayload carries interim analysis, tool calls, and turn", () => {
  const payload = judgeThinkingPayload({
    rawAnalysis: "requested a tool",
    toolCalls: [{ id: "t1" }],
    turn: 3
  });
  assert.equal(payload.raw_analysis, "requested a tool");
  assert.deepEqual(payload.tool_calls, [{ id: "t1" }]);
  assert.equal(payload.turn, 3);
});

test("judgeFinalPayload mirrors the final output into the record", () => {
  const payload = judgeFinalPayload({ content: "answer", usage: { total_tokens: 5 } });
  assert.equal(payload.final_output, "answer");
  assert.deepEqual(payload.record, { final_output: "answer" });
  assert.deepEqual(payload.usage, { total_tokens: 5 });
});

test("an in-process listener enables the emitter and receives events synchronously", () => {
  const emitter = new TraceEmitter({});
  assert.equal(emitter.isEnabled(), false, "no sinks, no listeners: disabled");

  const seen: FusionTraceEvent[] = [];
  const listener = (event: FusionTraceEvent): void => {
    seen.push(event);
  };
  emitter.addListener(listener);
  assert.equal(emitter.isEnabled(), true, "a listener enables emission without URL/DIR sinks");

  emitter.emit({
    component: "panel-model",
    event_type: "harness.candidate.started",
    traceId: "trace_listener",
    modelId: "gpt"
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.trace_id, "trace_listener");
  assert.equal(seen[0]?.event_type, "harness.candidate.started");
  assert.equal(seen[0]?.model_id, "gpt");

  emitter.removeListener(listener);
  assert.equal(emitter.isEnabled(), false, "removing the last listener disables emission again");
  emitter.emit({ component: "judge", event_type: "judge.request", traceId: "trace_listener" });
  assert.equal(seen.length, 1, "a removed listener sees nothing");
});

test("a throwing listener never breaks emit (and other listeners still fire)", () => {
  const emitter = new TraceEmitter({});
  const seen: string[] = [];
  emitter.addListener(() => {
    throw new Error("broken listener");
  });
  emitter.addListener((event) => seen.push(event.event_type));
  assert.doesNotThrow(() =>
    emitter.emit({ component: "judge", event_type: "judge.request", traceId: "trace_x" })
  );
  assert.deepEqual(seen, ["judge.request"]);
});

test("model-call payloads use snake_case prompt + token fields", () => {
  const started = modelCallStartedPayload({ model: "m", systemPrompt: "sys", prompt: "task", tools: ["run"] });
  assert.equal(started.system_prompt, "sys");
  assert.equal(started.prompt, "task");
  assert.deepEqual(started.tools, ["run"]);

  const finished = modelCallFinishedPayload({
    model: "m",
    finalOutput: "done",
    finishReason: "stop",
    usage: { total_tokens: 9 }
  });
  assert.equal(finished.final_output, "done");
  assert.equal(finished.finish_reason, "stop");
  assert.equal(finished.content_preview, "done");
});
