import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FusionBackend } from "../fusion-backend.js";
import type { WireTrajectory } from "../fusion-backend.js";

// node:test isolates each file in its own process, so enabling the trace emitter
// here (before its lazy singleton is created) does not affect other suites.
const traceDir = mkdtempSync(join(tmpdir(), "fusion-judge-trace-"));
process.env.FUSION_TRACE_DIR = traceDir;
delete process.env.FUSION_TRACE_URL;

function candidate(id: string): WireTrajectory {
  return { trajectory_id: id, model_id: id, status: "succeeded", final_output: "ok", steps: [] };
}

type TraceEvent = {
  component: string;
  event_type: string;
  parent_span_id?: string;
  span_id: string;
  ts: number;
  payload?: Record<string, unknown>;
};

function readEvents(): TraceEvent[] {
  const events: TraceEvent[] = [];
  for (const file of readdirSync(traceDir)) {
    if (!file.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(traceDir, file), "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      events.push(JSON.parse(line) as TraceEvent);
    }
  }
  return events;
}

async function startStepServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1/fusion/trajectory:step`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

test("FusionBackend emits the full judge prompt and final output", async () => {
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
    // judge.final is captured from a cloned response asynchronously.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const events = readEvents();
    const request = events.find((event) => event.event_type === "judge.request");
    assert.ok(request, "expected a judge.request event");
    assert.equal(request.component, "judge");
    assert.equal(request.payload?.judge_model, "judge-x");
    assert.equal(request.payload?.turn, 1, "first user message is turn 1");
    assert.deepEqual(request.payload?.trajectory_ids, ["c1", "c2"]);
    assert.ok(Array.isArray(request.payload?.messages), "judge prompt carries the conversation");
    assert.ok(Array.isArray(request.payload?.trajectories), "judge prompt carries candidate trajectories");
    assert.ok(typeof request.parent_span_id === "string", "judge span nests under the session span");

    const final = events.find((event) => event.event_type === "judge.final");
    assert.ok(final, "expected a judge.final event");
    assert.equal(final.payload?.final_output, "FUSED ANSWER");
    assert.equal(final.span_id, request.span_id, "request and final share the judge span");
  } finally {
    await step.close();
  }
});

test("an intermediate tool-call turn emits judge.thinking, not judge.final", async () => {
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

    const events = readEvents().filter((event) => event.ts >= since);
    assert.equal(
      events.some((event) => event.event_type === "judge.final"),
      false,
      "an intermediate tool-call turn must not be reported as judge.final"
    );
    const thinking = events.find((event) => event.event_type === "judge.thinking");
    assert.ok(thinking, "expected a judge.thinking event for the intermediate step");
    assert.ok(thinking.payload?.tool_calls, "judge.thinking carries the intermediate tool calls");
  } finally {
    await step.close();
  }
});
