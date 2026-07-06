/**
 * WS6 acceptance: dialect field mappings and honest drop recording.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  chatToAnthropicMessage,
  mapStopReason
} from "../adapters/anthropic.js";
import {
  DIALECT_DROPPED_ATTRIBUTE,
  resetDroppedFieldWarnings,
  withDroppedFieldSpan
} from "../adapters/dropped.js";
import { responsesToChat } from "../adapters/responses.js";
import { initFusionTracing, InMemorySpanExporter, SimpleSpanProcessor, startFusionSpan } from "@fusionkit/tracing";
import type { ReadableSpan } from "@fusionkit/tracing";

const exporter = new InMemorySpanExporter();
initFusionTracing({ serviceName: "dialect-fidelity-test", spanProcessors: [new SimpleSpanProcessor(exporter)] });

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

beforeEach(() => {
  resetDroppedFieldWarnings();
});

test("responsesToChat forwards parallel_tool_calls and reasoning effort", () => {
  const chat = responsesToChat(
    {
      model: "gpt-x",
      input: "hi",
      parallel_tool_calls: false,
      reasoning: { effort: "high" }
    },
    "local-model"
  );
  assert.equal(chat.parallel_tool_calls, false);
  assert.equal(chat.reasoning_effort, "high");
});

test("content_filter maps to Anthropic stop_reason refusal", () => {
  assert.equal(mapStopReason("content_filter"), "refusal");
  const message = chatToAnthropicMessage(
    {
      id: "cmpl-filter",
      choices: [{ message: { content: "nope" }, finish_reason: "content_filter" }]
    },
    "claude-x"
  );
  assert.equal(message.stop_reason, "refusal");
});

test("drop recorder warns once for previous_response_id", () => {
  const out = captureStderr(() => {
    responsesToChat({ model: "gpt-x", input: "hi", previous_response_id: "resp_old" }, "local-model");
  });
  assert.match(out, /responses field "previous_response_id" is not translated and was dropped/);
  const repeat = captureStderr(() => {
    responsesToChat({ model: "gpt-x", input: "hi", previous_response_id: "resp_other" }, "local-model");
  });
  assert.equal(repeat, "");
});

test("drop recorder appends to ambient span during translation", () => {
  const span = startFusionSpan("gateway", "test.responses.translate", undefined);
  captureStderr(() => {
    withDroppedFieldSpan(span, () => {
      responsesToChat({ model: "gpt-x", input: "hi", truncation: "auto" }, "local-model");
    });
  });
  span.end({ status: "succeeded" });
  const finished = (exporter.getFinishedSpans() as ReadableSpan[]).find(
    (candidate) => candidate.name === "test.responses.translate"
  );
  assert.ok(finished);
  assert.deepEqual(finished!.attributes[DIALECT_DROPPED_ATTRIBUTE], ["responses.truncation"]);
});
