/**
 * K-configurable panel semantics at the FusionBackend boundary: per-route k
 * resolution, caller tools flowing into the panel contract, per-round candidate
 * freshness for finite k (vs per-turn caching at k = ∞), and the `panel_mode`
 * field on the fuse-step body.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { FusionBackend } from "../fusion-backend.js";
import type { PanelRunInput, WireTrajectory } from "../fusion-backend.js";

function candidate(modelId: string): WireTrajectory {
  return { trajectory_id: `t_${modelId}`, model_id: modelId, status: "succeeded", final_output: "ok" };
}

function fuseOk(body: string): Response {
  void body;
  return new Response(
    JSON.stringify({ choices: [{ message: { role: "assistant", content: "fused" } }] }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

type Recorded = { panelInputs: PanelRunInput[]; stepBodies: Array<Record<string, unknown>> };

function backendWithRoutes(routes: Array<{ modelId: string; k?: number }>): {
  backend: FusionBackend;
  recorded: Recorded;
} {
  const recorded: Recorded = { panelInputs: [], stepBodies: [] };
  const backend = new FusionBackend({
    stepUrl: "http://127.0.0.1:1/v1/fusion/trajectories:fuse",
    runPanels: async (input) => {
      recorded.panelInputs.push(input);
      return [candidate("alpha"), candidate("beta")];
    },
    runFuseStep: async (request) => {
      recorded.stepBodies.push(JSON.parse(request.body) as Record<string, unknown>);
      return fuseOk(request.body);
    },
    defaultModel: routes[0]?.modelId ?? "fusion-panel",
    fusedModels: routes.map((route) => ({
      modelId: route.modelId,
      name: route.modelId,
      memberEndpointIds: ["alpha", "beta"],
      judgeEndpointId: "alpha",
      judgeModelName: "provider/alpha",
      ...(route.k !== undefined ? { k: route.k } : {})
    }))
  });
  return { backend, recorded };
}

const TOOLS = [{ type: "function", function: { name: "write_file", parameters: {} } }];

test("a k=1 route passes k + caller tools to the panel and step mode to the fuse body", async () => {
  const { backend, recorded } = backendWithRoutes([{ modelId: "fusion-step", k: 1 }]);
  const response = await backend.chat({
    model: "fusion-step",
    messages: [{ role: "user", content: "do the task" }],
    temperature: 0.6,
    top_p: 0.9,
    max_completion_tokens: 4096,
    seed: 7,
    reasoning: { effort: "high" },
    provider: { order: ["FirstParty"], allow_fallbacks: false },
    usage: { include: true },
    parallel_tool_calls: false,
    fusion: { include_evidence: true },
    tools: TOOLS,
    tool_choice: "auto"
  });
  assert.equal(response.status, 200);

  assert.equal(recorded.panelInputs.length, 1);
  const input = recorded.panelInputs[0];
  assert.equal(input?.k, 1);
  assert.deepEqual(input?.tools, TOOLS);
  assert.equal(input?.toolChoice, "auto");
  assert.equal(input?.temperature, 0.6);
  assert.equal(input?.topP, 0.9);
  assert.equal(input?.maxCompletionTokens, 4096);
  assert.equal(input?.seed, 7);
  assert.deepEqual(input?.reasoning, { effort: "high" });
  assert.deepEqual(input?.provider, {
    order: ["FirstParty"],
    allow_fallbacks: false
  });
  assert.deepEqual(input?.usage, { include: true });
  assert.equal(input?.parallelToolCalls, false);

  assert.deepEqual(recorded.stepBodies[0], {
    model: "fusion-step",
    messages: [{ role: "user", content: "do the task" }],
    trajectories: [candidate("alpha"), candidate("beta")],
    stream: false,
    temperature: 0.6,
    top_p: 0.9,
    max_completion_tokens: 4096,
    seed: 7,
    reasoning: { effort: "high" },
    provider: { order: ["FirstParty"], allow_fallbacks: false },
    usage: { include: true },
    parallel_tool_calls: false,
    include_evidence: true,
    tools: TOOLS,
    tool_choice: "auto",
    panel_mode: "step",
    judge_model: "alpha"
  });
});

test("an unset-k route projects losslessly (tools present) but carries no k or panel_mode", async () => {
  const { backend, recorded } = backendWithRoutes([{ modelId: "fusion-panel" }]);
  await backend.chat({
    model: "fusion-panel",
    messages: [{ role: "user", content: "do the task" }],
    tools: TOOLS
  });

  const input = recorded.panelInputs[0];
  assert.equal(input?.k, undefined);
  // Lossless projection: tools always describe the situation; the panel
  // runner (not the projection) decides that rollout members never see them.
  assert.deepEqual(input?.tools, TOOLS);
  assert.equal("panel_mode" in (recorded.stepBodies[0] ?? {}), false);
});

test("route selection is per request: two ensembles with different k in one gateway", async () => {
  const { backend, recorded } = backendWithRoutes([
    { modelId: "fusion-panel" },
    { modelId: "fusion-step", k: 1 }
  ]);
  await backend.chat({ model: "fusion-step", messages: [{ role: "user", content: "a" }] });
  await backend.chat({ model: "fusion-panel", messages: [{ role: "user", content: "b" }] });

  assert.equal(recorded.panelInputs[0]?.k, 1);
  assert.equal(recorded.panelInputs[1]?.k, undefined);
  assert.equal(recorded.stepBodies[0]?.panel_mode, "step");
  assert.equal("panel_mode" in (recorded.stepBodies[1] ?? {}), false);
});

test("finite k re-runs the panel on a tool-result continuation; k=∞ reuses the cached turn", async () => {
  const messages = [{ role: "user", content: "do the task" }];
  const continuation = [
    ...messages,
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: "{}" } }]
    },
    { role: "tool", tool_call_id: "c1", content: "wrote it" }
  ];

  // k=1: both requests are the same user turn, but each round re-proposes.
  const step = backendWithRoutes([{ modelId: "fusion-step", k: 1 }]);
  await step.backend.chat({ model: "fusion-step", messages });
  await step.backend.chat({ model: "fusion-step", messages: continuation });
  assert.equal(step.recorded.panelInputs.length, 2, "finite k must re-propose every round");
  assert.deepEqual(
    step.recorded.panelInputs[1]?.messages,
    continuation,
    "the re-proposal sees the updated history including tool results"
  );

  // k unset: the tool-result continuation of the same turn reuses the cached panel.
  const traj = backendWithRoutes([{ modelId: "fusion-panel" }]);
  await traj.backend.chat({ model: "fusion-panel", messages });
  await traj.backend.chat({ model: "fusion-panel", messages: continuation });
  assert.equal(traj.recorded.panelInputs.length, 1, "k=∞ keeps per-user-turn candidate caching");
});
