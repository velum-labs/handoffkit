import assert from "node:assert/strict";
import { test } from "node:test";

import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";

import {
  addSpanListener,
  attrJson,
  attrNum,
  attrStr,
  carrierFromEnv,
  carrierFromHeaders,
  emitFusionMarker,
  envOf,
  fusionBaggageOf,
  headersOf,
  initFusionTracing,
  jsonAttr,
  newSessionCarrier,
  removeSpanListener,
  startFusionSpan,
  traceIdOf,
  withFusionBaggage
} from "../index.js";
import type { ReadableSpan } from "../index.js";

const exporter = new InMemorySpanExporter();
initFusionTracing({
  serviceName: "tracing-test",
  spanProcessors: [new SimpleSpanProcessor(exporter)]
});

function finished(): ReadableSpan[] {
  return exporter.getFinishedSpans() as ReadableSpan[];
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

test("markers are zero-duration children of their unit span", () => {
  exporter.reset();
  const session = newSessionCarrier();
  const candidate = startFusionSpan("panel-model", "fusion.candidate", session.carrier, {
    "fusion.candidate.id": "cand_gpt"
  });
  candidate.marker("panel-model", "fusion.candidate.step", {
    "fusion.step": jsonAttr({ index: 0, type: "reasoning", text: "thinking" }),
    "fusion.step.index": 0
  });
  candidate.end({ status: "succeeded", attributes: { "fusion.step_count": 1 } });

  const spans = finished();
  const step = spans.find((s) => s.name === "fusion.candidate.step");
  const cand = spans.find((s) => s.name === "fusion.candidate");
  assert.ok(step && cand);
  assert.equal(step.parentSpanContext?.spanId, cand.spanContext().spanId);
  assert.equal(step.spanContext().traceId, session.traceId);
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
    emitFusionMarker("judge", "fusion.judge.thinking", newSessionCarrier().carrier, {
      "fusion.raw_analysis": "hmm"
    });
    assert.deepEqual(seen, ["fusion.judge.thinking"]);
  } finally {
    removeSpanListener(bad);
    removeSpanListener(good);
  }
});

test("markers without a carrier are dropped (no trace identity, no consumer)", () => {
  exporter.reset();
  emitFusionMarker("gateway", "fusion.cost", undefined, { "fusion.cost.turn_usd": 0.01 });
  assert.equal(finished().length, 0);
});
