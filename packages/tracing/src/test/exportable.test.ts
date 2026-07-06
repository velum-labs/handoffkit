import assert from "node:assert/strict";
import { test } from "node:test";

import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";

import {
  ATTR,
  AllowlistSpanExporter,
  initFusionTracing,
  isLoopbackOtlpEndpoint,
  startFusionSpan,
  newSessionCarrier,
  TRACE_REDACTED_ATTRIBUTE
} from "../index.js";
import type { ReadableSpan } from "../index.js";

/**
 * Full-fidelity span payloads (prompts, trajectories, outputs) must never
 * cross a non-loopback OTLP boundary: the allowlist exporter drops everything
 * outside the protocol's EXPORTABLE_ATTRIBUTES and marks the span redacted.
 */

const filtered = new InMemorySpanExporter();
const passthrough = new InMemorySpanExporter();
initFusionTracing({
  serviceName: "exportable-test",
  spanProcessors: [
    new SimpleSpanProcessor(new AllowlistSpanExporter(filtered)),
    new SimpleSpanProcessor(new AllowlistSpanExporter(passthrough, { fullFidelity: true }))
  ]
});

function emitSpanWithPrompt(): void {
  const session = newSessionCarrier();
  const span = startFusionSpan("gateway", "fusion.turn", session.carrier, {
    [ATTR.FUSION_TURN]: 1,
    [ATTR.FUSION_PROMPT]: "the user's secret prompt"
  });
  span.end({ status: "succeeded" });
}

test("non-loopback export drops non-allowlisted attributes and marks redaction", () => {
  filtered.reset();
  passthrough.reset();
  emitSpanWithPrompt();

  const exported = filtered.getFinishedSpans() as ReadableSpan[];
  assert.equal(exported.length, 1);
  const span = exported[0]!;
  assert.equal(span.attributes[ATTR.FUSION_PROMPT], undefined, "prompt must not leave the machine");
  assert.equal(span.attributes[ATTR.FUSION_TURN], 1, "allowlisted attributes must survive");
  assert.equal(span.attributes[TRACE_REDACTED_ATTRIBUTE], true, "redaction must be visible downstream");
  assert.ok(span.droppedAttributesCount >= 1);
});

test("full-fidelity export passes spans through unchanged", () => {
  filtered.reset();
  passthrough.reset();
  emitSpanWithPrompt();

  const exported = passthrough.getFinishedSpans() as ReadableSpan[];
  assert.equal(exported.length, 1);
  const span = exported[0]!;
  assert.equal(span.attributes[ATTR.FUSION_PROMPT], "the user's secret prompt");
  assert.equal(span.attributes[TRACE_REDACTED_ATTRIBUTE], undefined);
});

test("loopback endpoint detection", () => {
  assert.equal(isLoopbackOtlpEndpoint("http://127.0.0.1:4318/v1/traces"), true);
  assert.equal(isLoopbackOtlpEndpoint("http://localhost:4318"), true);
  assert.equal(isLoopbackOtlpEndpoint("http://[::1]:4318"), true);
  assert.equal(isLoopbackOtlpEndpoint("https://otlp.example.com/v1/traces"), false);
  assert.equal(isLoopbackOtlpEndpoint("not a url"), false);
  assert.equal(isLoopbackOtlpEndpoint(undefined), false);
});
