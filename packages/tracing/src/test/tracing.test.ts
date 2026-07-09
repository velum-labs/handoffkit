import assert from "node:assert/strict";
import { test } from "node:test";

import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";

import {
  addFusionEventListener,
  addSpanListener,
  attrJson,
  attrNum,
  attrStr,
  carrierFromEnv,
  carrierFromHeaders,
  emitFusionEvent,
  envOf,
  eventNameOf,
  eventSpanId,
  eventTraceId,
  fusionBaggageOf,
  headersOf,
  initFusionTracing,
  jsonAttr,
  newSessionCarrier,
  removeFusionEventListener,
  removeSpanListener,
  startFusionSpan,
  traceIdOf,
  withFusionBaggage
} from "../index.js";
import type { ReadableFusionEvent, ReadableSpan } from "../index.js";

const exporter = new InMemorySpanExporter();
const eventExporter = new InMemoryLogRecordExporter();
initFusionTracing({
  serviceName: "tracing-test",
  spanProcessors: [new SimpleSpanProcessor(exporter)],
  logRecordProcessors: [new SimpleLogRecordProcessor({ exporter: eventExporter })]
});

function finished(): ReadableSpan[] {
  return exporter.getFinishedSpans() as ReadableSpan[];
}

function emitted(): ReadableFusionEvent[] {
  return eventExporter.getFinishedLogRecords();
}

test("session carrier mints a W3C traceparent and unit spans parent onto it", () => {
  exporter.reset();
  const session = newSessionCarrier();
  assert.match(session.carrier.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  assert.equal(traceIdOf(session.carrier), session.traceId);

  const turn = startFusionSpan("gateway", "fusion.turn", session.carrier, { "fusion.turn": 1 });
  assert.equal(turn.traceId, session.traceId);
  turn.end({ status: "succeeded" });

  const spans = finished();
  assert.equal(spans.length, 1);
  const span = spans[0]!;
  assert.equal(span.name, "fusion.turn");
  assert.equal(span.spanContext().traceId, session.traceId);
  assert.equal(attrNum(span, "fusion.turn"), 1);
  assert.equal(attrStr(span, "fusion.status"), "succeeded");
});

test("events correlate to their unit span and carry fusion attributes", () => {
  exporter.reset();
  eventExporter.reset();
  const session = newSessionCarrier();
  const candidate = startFusionSpan("panel-model", "fusion.candidate", session.carrier, {
    "fusion.candidate.id": "cand_gpt"
  });
  candidate.event("panel-model", "fusion.candidate.step", {
    "fusion.step": jsonAttr({ index: 0, type: "reasoning", text: "thinking" }),
    "fusion.step.index": 0
  });
  candidate.end({ status: "succeeded", attributes: { "fusion.step_count": 1 } });

  const cand = finished().find((s) => s.name === "fusion.candidate");
  const [step] = emitted();
  assert.ok(step !== undefined && cand !== undefined);
  assert.equal(eventNameOf(step), "fusion.candidate.step");
  assert.equal(eventSpanId(step), cand.spanContext().spanId);
  assert.equal(eventTraceId(step), session.traceId);
  assert.deepEqual(attrJson(step, "fusion.step"), { index: 0, type: "reasoning", text: "thinking" });
  assert.equal(attrNum(cand, "fusion.step_count"), 1);
});

test("failed spans record error status and fusion.error", () => {
  exporter.reset();
  const span = startFusionSpan("gateway", "fusion.run", undefined, {});
  span.end({ status: "failed", error: "provider exploded" });
  const [only] = finished();
  assert.equal(attrStr(only!, "fusion.status"), "failed");
  assert.equal(attrStr(only!, "fusion.error"), "provider exploded");
  assert.equal(only!.status.code, 2, "OTel StatusCode.ERROR");
});

test("carriers round-trip through headers and env with baggage", () => {
  const session = newSessionCarrier();
  const tagged = withFusionBaggage(session.carrier, {
    candidateId: "cand one",
    trajectoryId: "traj_1",
    turn: 3
  });
  assert.equal(traceIdOf(tagged), session.traceId, "baggage does not change trace identity");

  const viaHeaders = carrierFromHeaders(headersOf(tagged));
  assert.ok(viaHeaders);
  assert.deepEqual(fusionBaggageOf(viaHeaders), { candidateId: "cand one", trajectoryId: "traj_1", turn: 3 });

  const viaEnv = carrierFromEnv(envOf(tagged) as NodeJS.ProcessEnv);
  assert.ok(viaEnv);
  assert.deepEqual(fusionBaggageOf(viaEnv), { candidateId: "cand one", trajectoryId: "traj_1", turn: 3 });
});

test("in-process listeners see finished spans synchronously and survive throwing listeners", () => {
  exporter.reset();
  const seen: string[] = [];
  const bad = () => {
    throw new Error("broken listener");
  };
  const good = (span: ReadableSpan) => {
    seen.push(span.name);
  };
  addSpanListener(bad);
  addSpanListener(good);
  try {
    const span = startFusionSpan("judge", "fusion.judge", newSessionCarrier().carrier, {});
    span.end({ status: "succeeded" });
    assert.deepEqual(seen, ["fusion.judge"]);
  } finally {
    removeSpanListener(bad);
    removeSpanListener(good);
  }
});

test("in-process event listeners see events synchronously and survive throwing listeners", () => {
  eventExporter.reset();
  const seen: string[] = [];
  const bad = () => {
    throw new Error("broken listener");
  };
  const good = (event: ReadableFusionEvent) => {
    seen.push(eventNameOf(event));
  };
  addFusionEventListener(bad);
  addFusionEventListener(good);
  try {
    emitFusionEvent("judge", "fusion.judge.thinking", newSessionCarrier().carrier, {
      "fusion.raw_analysis": "hmm"
    });
    assert.deepEqual(seen, ["fusion.judge.thinking"]);
  } finally {
    removeFusionEventListener(bad);
    removeFusionEventListener(good);
  }
});

test("events without a carrier are dropped (no trace identity, no consumer)", () => {
  eventExporter.reset();
  emitFusionEvent("gateway", "fusion.cost", undefined, { "fusion.cost.turn_usd": 0.01 });
  assert.equal(emitted().length, 0);
});
