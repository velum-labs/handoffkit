import assert from "node:assert/strict";
import { test } from "node:test";

import type { WireTrajectory } from "@fusionkit/protocol";

import { runFrontdoorRequest } from "../frontdoor/request.js";
import { eventsToSseResponse } from "../frontdoor/sse.js";
import {
  runFusionFrontdoorTurn,
  runFusionPassthroughTurn,
  streamFusionFrontdoorTurn
} from "../frontdoor/workflow.js";

function candidate(id: string): WireTrajectory {
  return { trajectory_id: id, model_id: id, status: "succeeded", final_output: "ok" };
}

function jsonResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

test("runFusionFrontdoorTurn runs panel -> fuse -> finalize in order and returns the response", async () => {
  const calls: string[] = [];
  const outcome = await runFusionFrontdoorTurn({
    resolveCandidates: async () => {
      calls.push("panel");
      return [candidate("a"), candidate("b")];
    },
    runFuseStep: async (candidates) => {
      calls.push(`fuse:${candidates.length}`);
      return jsonResponse("fused");
    },
    finalize: async (response) => {
      calls.push("finalize");
      return response;
    }
  });
  assert.equal(outcome.kind, "response");
  if (outcome.kind === "response") {
    const body = (await outcome.response.json()) as { choices: Array<{ message: { content: string } }> };
    assert.equal(body.choices[0]?.message.content, "fused");
  }
  assert.deepEqual(calls, ["panel", "fuse:2", "finalize"]);
});

test("runFusionFrontdoorTurn surfaces a panel failure as a panel_error outcome (no fuse)", async () => {
  let fuseRan = false;
  const outcome = await runFusionFrontdoorTurn({
    resolveCandidates: async () => {
      throw new Error("panel boom");
    },
    runFuseStep: async () => {
      fuseRan = true;
      return jsonResponse("nope");
    },
    finalize: async (response) => response
  });
  assert.equal(outcome.kind, "panel_error");
  if (outcome.kind === "panel_error") {
    assert.match(outcome.error instanceof Error ? outcome.error.message : String(outcome.error), /panel boom/);
  }
  assert.equal(fuseRan, false, "the fuse operator never runs when the panel fails");
});

test("streamFusionFrontdoorTurn pipes the fuse SSE bytes as events and reports completion", async () => {
  const sse =
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
    "data: [DONE]\n\n";
  let completed = "";
  const events = streamFusionFrontdoorTurn({
    resolveCandidates: async () => [candidate("a")],
    openFuseStream: async () =>
      new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
    onUpstreamError: () => undefined,
    onComplete: (buffer) => {
      completed = buffer;
    }
  });
  const res = eventsToSseResponse(events);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const text = await res.text();
  assert.match(text, /hello/);
  assert.match(text, /\[DONE\]/);
  assert.match(completed, /hello/, "onComplete receives the full SSE buffer for metering/trace");
});

test("streamFusionFrontdoorTurn emits a terminal error event and evicts on a panel failure", async () => {
  let evicted = false;
  const events = streamFusionFrontdoorTurn({
    resolveCandidates: async () => {
      throw new Error("panel boom");
    },
    openFuseStream: async () => new Response("", { status: 200 }),
    onUpstreamError: () => undefined,
    onComplete: () => undefined
  });
  const res = eventsToSseResponse(events, { onError: () => (evicted = true) });
  const text = await res.text();
  assert.match(text, /fusion error/);
  assert.match(text, /"finish_reason":"error"/);
  assert.match(text, /\[DONE\]/);
  assert.equal(evicted, true, "a failed streaming turn evicts the session so the panel re-runs");
});

test("streamFusionFrontdoorTurn surfaces a non-2xx fuse reply as an upstream error", async () => {
  let upstreamStatus = 0;
  const events = streamFusionFrontdoorTurn({
    resolveCandidates: async () => [candidate("a")],
    openFuseStream: async () => new Response("boom", { status: 500 }),
    onUpstreamError: (status) => {
      upstreamStatus = status;
    },
    onComplete: () => undefined
  });
  const res = eventsToSseResponse(events);
  const text = await res.text();
  assert.match(text, /fusion error/);
  assert.match(text, /trajectories:fuse 500/);
  assert.equal(upstreamStatus, 500);
});

test("runFusionPassthroughTurn returns the proxied vendor response", async () => {
  const res = await runFusionPassthroughTurn({ proxy: async () => jsonResponse("native answer") });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  assert.equal(body.choices[0]?.message.content, "native answer");
});

test("runFrontdoorRequest short-circuits to budget-stop before any turn runs", async () => {
  let fusionRan = false;
  let passthroughRan = false;
  const res = await runFrontdoorRequest({
    isBudgetExceeded: () => true,
    budgetStop: () => new Response(JSON.stringify({ error: { message: "budget cap reached" } }), { status: 402 }),
    resolveRoute: () => "fusion",
    runFusion: async () => {
      fusionRan = true;
      return jsonResponse("fused");
    },
    runPassthrough: async () => {
      passthroughRan = true;
      return jsonResponse("native");
    }
  });
  assert.equal(res.status, 402);
  assert.equal(fusionRan, false, "budget stop runs no turn");
  assert.equal(passthroughRan, false);
});

test("runFrontdoorRequest routes a native model to the passthrough turn (not fusion)", async () => {
  let fusionRan = false;
  const res = await runFrontdoorRequest({
    isBudgetExceeded: () => false,
    budgetStop: () => new Response("", { status: 402 }),
    resolveRoute: () => "passthrough",
    runFusion: async () => {
      fusionRan = true;
      return jsonResponse("fused");
    },
    runPassthrough: async () => jsonResponse("native answer")
  });
  const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  assert.equal(body.choices[0]?.message.content, "native answer");
  assert.equal(fusionRan, false, "the fusion turn does not run for a native model");
});

test("runFrontdoorRequest routes the fused model to the fusion turn (not passthrough)", async () => {
  let passthroughRan = false;
  const res = await runFrontdoorRequest({
    isBudgetExceeded: () => false,
    budgetStop: () => new Response("", { status: 402 }),
    resolveRoute: () => "fusion",
    runFusion: async () => jsonResponse("fused answer"),
    runPassthrough: async () => {
      passthroughRan = true;
      return jsonResponse("native");
    }
  });
  const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  assert.equal(body.choices[0]?.message.content, "fused answer");
  assert.equal(passthroughRan, false, "the passthrough turn does not run for the fused model");
});
