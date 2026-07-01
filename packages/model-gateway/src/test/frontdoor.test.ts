import assert from "node:assert/strict";
import { test } from "node:test";

import type { WireTrajectory } from "@fusionkit/protocol";

import { runFrontdoorRequest } from "../frontdoor/request.js";
import { eventsToSseResponse } from "../frontdoor/sse.js";
import type { FrontdoorRequestValue, FrontdoorServices } from "../frontdoor/types.js";
import { runFusionFrontdoorTurn, streamFusionFrontdoorTurn } from "../frontdoor/workflow.js";

function candidate(id: string): WireTrajectory {
  return { trajectory_id: id, model_id: id, status: "succeeded", final_output: "ok" };
}

function jsonResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

/** A default services stub; every method is overridable per test. */
function makeServices(overrides: Partial<FrontdoorServices> = {}): FrontdoorServices {
  return {
    budgetUsd: undefined,
    costTotalUsd: () => 0,
    budgetStopResponse: () => new Response("", { status: 402 }),
    isNativeModel: () => false,
    resolvePanelCandidates: async () => [candidate("a")],
    runFuseStep: async () => jsonResponse("fused"),
    openFuseStream: async () =>
      new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
    finalizeFused: async (_req, response) => response,
    meterAndTraceStream: () => undefined,
    onFuseUpstreamError: () => undefined,
    onFuseException: () => undefined,
    proxyVendor: async () => ({ kind: "response", response: jsonResponse("native") }),
    evictTurn: () => undefined,
    ...overrides
  };
}

function makeReq(overrides: Partial<FrontdoorRequestValue> = {}): FrontdoorRequestValue {
  return {
    requestId: "req",
    chat: { messages: [] },
    sessionKey: "session",
    turn: 1,
    judgeSpanId: "judge-span",
    streaming: false,
    ...overrides
  };
}

test("runFusionFrontdoorTurn runs panel -> fuse -> finalize in order and returns the response", async () => {
  const calls: string[] = [];
  const services = makeServices({
    resolvePanelCandidates: async () => {
      calls.push("panel");
      return [candidate("a"), candidate("b")];
    },
    runFuseStep: async (_req, candidates) => {
      calls.push(`fuse:${candidates.length}`);
      return jsonResponse("fused");
    },
    finalizeFused: async (_req, response) => {
      calls.push("finalize");
      return response;
    }
  });
  const outcome = await runFusionFrontdoorTurn(services, makeReq());
  assert.equal(outcome.kind, "response");
  if (outcome.kind === "response") {
    const body = (await outcome.response.json()) as { choices: Array<{ message: { content: string } }> };
    assert.equal(body.choices[0]?.message.content, "fused");
  }
  assert.deepEqual(calls, ["panel", "fuse:2", "finalize"]);
});

test("runFusionFrontdoorTurn surfaces a panel failure as a panel_error outcome (no fuse)", async () => {
  let fuseRan = false;
  const services = makeServices({
    resolvePanelCandidates: async () => {
      throw new Error("panel boom");
    },
    runFuseStep: async () => {
      fuseRan = true;
      return jsonResponse("nope");
    }
  });
  const outcome = await runFusionFrontdoorTurn(services, makeReq());
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
  const services = makeServices({
    resolvePanelCandidates: async () => [candidate("a")],
    openFuseStream: async () =>
      new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
    meterAndTraceStream: (_req, buffer) => {
      completed = buffer;
    }
  });
  const res = eventsToSseResponse(streamFusionFrontdoorTurn(services, makeReq({ streaming: true })));
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const text = await res.text();
  assert.match(text, /hello/);
  assert.match(text, /\[DONE\]/);
  assert.match(completed, /hello/, "meterAndTraceStream receives the full SSE buffer");
});

test("streamFusionFrontdoorTurn emits a terminal error event and evicts on a panel failure", async () => {
  let evicted = false;
  const services = makeServices({
    resolvePanelCandidates: async () => {
      throw new Error("panel boom");
    }
  });
  const res = eventsToSseResponse(streamFusionFrontdoorTurn(services, makeReq({ streaming: true })), {
    onError: () => (evicted = true)
  });
  const text = await res.text();
  assert.match(text, /fusion error/);
  assert.match(text, /"finish_reason":"error"/);
  assert.match(text, /\[DONE\]/);
  assert.equal(evicted, true, "a failed streaming turn evicts the session so the panel re-runs");
});

test("streamFusionFrontdoorTurn surfaces a non-2xx fuse reply as an upstream error", async () => {
  let upstreamStatus = 0;
  const services = makeServices({
    resolvePanelCandidates: async () => [candidate("a")],
    openFuseStream: async () => new Response("boom", { status: 500 }),
    onFuseUpstreamError: (_req, status) => {
      upstreamStatus = status;
    }
  });
  const res = eventsToSseResponse(streamFusionFrontdoorTurn(services, makeReq({ streaming: true })));
  const text = await res.text();
  assert.match(text, /fusion error/);
  assert.match(text, /trajectories:fuse 500/);
  assert.equal(upstreamStatus, 500);
});

test("runFrontdoorRequest short-circuits to budget-stop before any turn runs", async () => {
  let fusionRan = false;
  let passthroughRan = false;
  const services = makeServices({
    budgetUsd: 0.001,
    costTotalUsd: () => 1,
    budgetStopResponse: () =>
      new Response(JSON.stringify({ error: { message: "budget cap reached" } }), { status: 402 }),
    resolvePanelCandidates: async () => {
      fusionRan = true;
      return [candidate("a")];
    },
    proxyVendor: async () => {
      passthroughRan = true;
      return { kind: "response", response: jsonResponse("native") };
    }
  });
  const res = await runFrontdoorRequest(services, makeReq());
  assert.equal(res.status, 402);
  assert.equal(fusionRan, false, "budget stop runs no turn");
  assert.equal(passthroughRan, false);
});

test("runFrontdoorRequest routes a native model to the vendor proxy (not fusion)", async () => {
  let fusionRan = false;
  const services = makeServices({
    isNativeModel: () => true,
    resolvePanelCandidates: async () => {
      fusionRan = true;
      return [candidate("a")];
    },
    proxyVendor: async () => ({ kind: "response", response: jsonResponse("native answer") })
  });
  const res = await runFrontdoorRequest(services, makeReq({ chat: { model: "gpt-5.5", messages: [] } }));
  const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  assert.equal(body.choices[0]?.message.content, "native answer");
  assert.equal(fusionRan, false, "the fusion turn does not run for a native model");
});

test("runFrontdoorRequest routes the fused model to the fusion turn (not the vendor proxy)", async () => {
  let vendorRan = false;
  const services = makeServices({
    isNativeModel: () => false,
    runFuseStep: async () => jsonResponse("fused answer"),
    proxyVendor: async () => {
      vendorRan = true;
      return { kind: "response", response: jsonResponse("native") };
    }
  });
  const res = await runFrontdoorRequest(services, makeReq());
  const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  assert.equal(body.choices[0]?.message.content, "fused answer");
  assert.equal(vendorRan, false, "the vendor proxy does not run for the fused model");
});

test("runFrontdoorRequest re-enters the fusion turn on a vendor pre-stream failover", async () => {
  let excluded: readonly string[] | undefined;
  const services = makeServices({
    isNativeModel: () => true,
    proxyVendor: async () => ({ kind: "failover", excludeModelIds: ["gpt"], notice: "handed off. " }),
    resolvePanelCandidates: async (req) => {
      excluded = req.excludeModelIds;
      return [candidate("a")];
    },
    runFuseStep: async () => jsonResponse("fused after failover")
  });
  const res = await runFrontdoorRequest(services, makeReq({ chat: { model: "gpt-5.5", messages: [] } }));
  const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  assert.equal(body.choices[0]?.message.content, "fused after failover");
  assert.deepEqual(excluded, ["gpt"], "the failover re-enters fusion with the throttled vendor excluded");
});
