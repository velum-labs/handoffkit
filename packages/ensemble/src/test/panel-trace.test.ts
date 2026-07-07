import assert from "node:assert/strict";
import { test } from "node:test";

import {
  attrJson,
  attrNum,
  attrStr,
  initFusionTracing,
  InMemorySpanExporter,
  newSessionCarrier,
  SimpleSpanProcessor,
  spanEndMs
} from "@fusionkit/tracing";
import type { ReadableSpan } from "@fusionkit/tracing";

import { traceCandidate } from "../candidate-trace.js";

const exporter = new InMemorySpanExporter();
initFusionTracing({ serviceName: "panel-trace-test", spanProcessors: [new SimpleSpanProcessor(exporter)] });

function spansOf(traceId: string): ReadableSpan[] {
  return (exporter.getFinishedSpans() as ReadableSpan[]).filter(
    (span) => span.spanContext().traceId === traceId
  );
}

test("traceCandidate emits a started marker, per-step markers, and a candidate span under the session trace", () => {
  // The tool harnesses (codex/claude/cursor) call traceCandidate so the
  // companion app renders their candidate trajectories the same way the agent
  // harness's do.
  exporter.reset();
  const session = newSessionCarrier();
  const tracer = traceCandidate(
    { trace: session.carrier, turn: 1 },
    { candidateId: "cand_a", modelId: "a", model: "mlx/alpha", branchName: "b", worktreePath: "/w" }
  );
  tracer.finished({
    status: "succeeded",
    steps: [
      { index: 0, type: "tool_call", tool_name: "read_file" },
      { index: 1, type: "output", text: "the answer" }
    ],
    finalOutput: "the answer",
    toolCallCount: 1,
    finishReason: "stop"
  });

  const spans = spansOf(session.traceId);
  const started = spans.find((span) => span.name === "fusion.candidate.started");
  const steps = spans.filter((span) => span.name === "fusion.candidate.step");
  const candidate = spans.find((span) => span.name === "fusion.candidate");

  assert.ok(started, "started marker emitted");
  assert.equal(attrStr(started, "fusion.candidate.id"), "cand_a");
  assert.equal(attrStr(started, "fusion.model.id"), "a");
  assert.equal(attrStr(started, "gen_ai.request.model"), "mlx/alpha");
  assert.equal(attrStr(started, "fusion.branch_name"), "b");

  assert.equal(steps.length, 2, "one step marker per reconstructed step");
  assert.equal(attrJson<{ type?: string }>(steps[0]!, "fusion.step")?.type, "tool_call");

  assert.ok(candidate, "candidate span emitted");
  assert.equal(attrStr(candidate, "fusion.status"), "succeeded");
  assert.equal(attrNum(candidate, "fusion.step_count"), 2);
  assert.equal(attrStr(candidate, "fusion.final_output_preview"), "the answer");
  assert.equal(
    started.parentSpanContext?.spanId,
    candidate.spanContext().spanId,
    "the started marker nests under the candidate span"
  );
});

test("traceCandidate emits live steps and does not replay them at finish", async () => {
  exporter.reset();
  const session = newSessionCarrier();
  const tracer = traceCandidate({ trace: session.carrier, turn: 1 }, { candidateId: "cand_live", modelId: "live" });
  tracer.step({ index: 0, type: "tool_call", tool_name: "read_file" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  tracer.finished({
    status: "succeeded",
    steps: [
      { index: 0, type: "tool_call", tool_name: "read_file" },
      { index: 1, type: "output", text: "done" }
    ],
    finalOutput: "done"
  });

  const steps = spansOf(session.traceId).filter((span) => span.name === "fusion.candidate.step");
  assert.equal(steps.length, 2, "finish only emits the not-yet-streamed step");
  assert.equal(attrNum(steps[0]!, "fusion.step.index"), 0);
  assert.equal(attrNum(steps[1]!, "fusion.step.index"), 1);
  assert.ok(spanEndMs(steps[0]!) < spanEndMs(steps[1]!), "live step timestamp precedes finish replay");
});

test("traceCandidate is a no-op without a trace carrier", () => {
  // No carrier -> nothing emitted, no throw (harnesses call it unconditionally).
  exporter.reset();
  const tracer = traceCandidate({}, { candidateId: "cand_x", modelId: "x" });
  assert.doesNotThrow(() => tracer.step({ index: 0, type: "output", text: "ignored" }));
  assert.doesNotThrow(() => tracer.finished({ status: "succeeded", steps: [] }));
  assert.equal(exporter.getFinishedSpans().length, 0);
});
