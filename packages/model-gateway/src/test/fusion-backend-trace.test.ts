import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";

import {
  attrJson,
  attrNum,
  attrStr,
  initFusionTracing,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  spanEndMs
} from "@fusionkit/tracing";
import type { ReadableSpan } from "@fusionkit/tracing";

import { FusionBackend } from "../fusion-backend.js";
import type { WireTrajectory } from "../fusion-backend.js";

// node:test isolates each file in its own process, so installing the tracer
// provider here does not affect other suites.
const exporter = new InMemorySpanExporter();
initFusionTracing({ serviceName: "fusion-backend-trace-test", spanProcessors: [new SimpleSpanProcessor(exporter)] });

function candidate(id: string): WireTrajectory {
  return { trajectory_id: id, model_id: id, status: "succeeded", final_output: "ok", items: [] };
}

function spans(): ReadableSpan[] {
  return exporter.getFinishedSpans() as ReadableSpan[];
}

async function startStepServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ url: string; close: () => Promise<void>; headers: Array<Record<string, string | string[] | undefined>> }> {
  const headers: Array<Record<string, string | string[] | undefined>> = [];
  const server = createServer((req, res) => {
    headers.push(req.headers);
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1/fusion/trajectory:step`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    headers
  };
}

test("FusionBackend traces the judge phase: request marker, judge span, traceparent to the fuse step", async () => {
  exporter.reset();
  const step = await startStepServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "FUSED ANSWER" } }],
        usage: { total_tokens: 12 }
      })
    );
  });
  try {
    const backend = new FusionBackend({
      stepUrl: step.url,
      judgeModel: "judge-x",
      runPanels: async () => [candidate("c1"), candidate("c2")]
    });
    const res = await backend.chat({ messages: [{ role: "user", content: "the task" }], stream: false });
    await res.text();
    // The judge span ends from a cloned response asynchronously.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const request = spans().find((span) => span.name === "fusion.judge.request");
    assert.ok(request, "expected a fusion.judge.request marker");
    assert.equal(attrStr(request, "fusion.judge.model"), "judge-x");
    assert.equal(attrNum(request, "fusion.turn"), 1, "first user message is turn 1");
    assert.deepEqual(request.attributes["fusion.trajectory_ids"], ["c1", "c2"]);
    assert.ok(Array.isArray(attrJson(request, "fusion.messages")), "judge input carries the conversation");
    assert.ok(Array.isArray(attrJson(request, "fusion.trajectories")), "judge input carries candidate trajectories");

    const judge = spans().find((span) => span.name === "fusion.judge");
    assert.ok(judge, "expected the fusion.judge span");
    assert.equal(attrStr(judge, "fusion.final_output"), "FUSED ANSWER");
    assert.equal(attrStr(judge, "fusion.status"), "succeeded");
    assert.equal(
      request.parentSpanContext?.spanId,
      judge.spanContext().spanId,
      "the request marker nests under the judge span"
    );
    assert.equal(
      request.spanContext().traceId,
      judge.spanContext().traceId,
      "marker and span share the session trace"
    );

    // The fuse step HTTP call carries the judge span's W3C trace context.
    const stepHeaders = step.headers[0];
    assert.ok(stepHeaders, "fuse step was called");
    const traceparent = stepHeaders.traceparent;
    assert.ok(typeof traceparent === "string", "fuse step receives a traceparent header");
    assert.ok(
      traceparent.includes(judge.spanContext().traceId),
      "the fuse step continues the session trace"
    );
  } finally {
    await step.close();
  }
});

test("an intermediate tool-call turn emits fusion.judge.thinking and keeps the judge span open", async () => {
  exporter.reset();
  const step = await startStepServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "t1", type: "function", function: { name: "run", arguments: "{}" } }]
            },
            finish_reason: "tool_calls"
          }
        ]
      })
    );
  });
  try {
    const since = Date.now();
    const backend = new FusionBackend({ stepUrl: step.url, runPanels: async () => [candidate("c1")] });
    const res = await backend.chat({ messages: [{ role: "user", content: "intermediate task" }], stream: false });
    await res.text();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const recent = spans().filter((span) => spanEndMs(span) >= since);
    assert.equal(
      recent.some((span) => span.name === "fusion.judge"),
      false,
      "an intermediate tool-call turn must not end the judge span"
    );
    const thinking = recent.find((span) => span.name === "fusion.judge.thinking");
    assert.ok(thinking, "expected a fusion.judge.thinking marker for the intermediate step");
    assert.ok(attrJson(thinking, "fusion.tool_calls"), "the marker carries the intermediate tool calls");
  } finally {
    await step.close();
  }
});
