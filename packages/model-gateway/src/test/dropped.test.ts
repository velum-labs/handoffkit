/**
 * Acceptance tests for the dialect drop recorder (WS6.1): every deliberately
 * untranslated field is observable on the enclosing turn span and warns
 * exactly once per process.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { initFusionTracing, InMemorySpanExporter, SimpleSpanProcessor, startFusionSpan } from "@fusionkit/tracing";
import type { ReadableSpan } from "@fusionkit/tracing";

import {
  DIALECT_DROPPED_ATTRIBUTE,
  droppedField,
  resetDroppedFieldWarnings,
  withDroppedFieldSpan
} from "../adapters/dropped.js";

// node:test isolates each file in its own process, so installing the tracer
// provider here does not affect other suites.
const exporter = new InMemorySpanExporter();
initFusionTracing({ serviceName: "dropped-test", spanProcessors: [new SimpleSpanProcessor(exporter)] });

function captureStderr(run: () => void): string {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

function finishedSpan(name: string): ReadableSpan {
  const span = (exporter.getFinishedSpans() as ReadableSpan[]).find((candidate) => candidate.name === name);
  assert.ok(span, `span ${name} was exported`);
  return span;
}

beforeEach(() => {
  resetDroppedFieldWarnings();
});

test("warns once per distinct dialect.field, not per occurrence", () => {
  const first = captureStderr(() => droppedField("anthropic", "top_k"));
  const repeat = captureStderr(() => droppedField("anthropic", "top_k"));
  const other = captureStderr(() => droppedField("responses", "truncation"));
  assert.match(first, /anthropic field "top_k" is not translated and was dropped/);
  assert.equal(repeat, "");
  assert.match(other, /responses field "truncation"/);
});

test("ctx narrows the warning and the span entry", () => {
  const out = captureStderr(() => droppedField("anthropic", "is_error", "tool_result"));
  assert.match(out, /anthropic field "tool_result.is_error"/);
});

test("appends every occurrence to the ambient span's dropped-list attribute", () => {
  const span = startFusionSpan("gateway", "test.dialect", undefined);
  captureStderr(() => {
    withDroppedFieldSpan(span, () => {
      droppedField("anthropic", "top_k");
      droppedField("anthropic", "metadata");
      droppedField("anthropic", "top_k");
    });
  });
  span.end({ status: "succeeded" });
  assert.deepEqual(finishedSpan("test.dialect").attributes[DIALECT_DROPPED_ATTRIBUTE], [
    "anthropic.top_k",
    "anthropic.metadata",
    "anthropic.top_k"
  ]);
});

test("survives async boundaries within the wrapped scope", async () => {
  const span = startFusionSpan("gateway", "test.dialect.async", undefined);
  await withDroppedFieldSpan(span, async () => {
    await Promise.resolve();
    captureStderr(() => droppedField("responses", "include"));
  });
  span.end({ status: "succeeded" });
  assert.deepEqual(finishedSpan("test.dialect.async").attributes[DIALECT_DROPPED_ATTRIBUTE], [
    "responses.include"
  ]);
});

test("is warn-only without an ambient span", () => {
  const out = captureStderr(() => droppedField("cursor", "reasoning"));
  assert.match(out, /cursor field "reasoning"/);
});
