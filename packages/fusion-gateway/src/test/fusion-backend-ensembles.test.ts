/**
 * Multi-ensemble routing: each named ensemble is advertised as its own fused
 * model id; a request to it fans out only that ensemble's members and carries
 * its judge/synthesizer endpoint ids + prompt overrides on the fuse step.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { FusionBackend } from "../fusion-backend.js";
import type { FusedModelRoute, PanelRunInput, WireTrajectory } from "../fusion-backend.js";
import { startGateway } from "@routekit/gateway";

function candidate(modelId: string, status = "succeeded"): WireTrajectory {
  return { trajectory_id: `t_${modelId}`, model_id: modelId, status, final_output: "ok" };
}

const userTurn = { messages: [{ role: "user", content: "do the task" }] };

type StepServer = {
  url: string;
  bodies: () => Array<Record<string, unknown>>;
  close: () => Promise<void>;
};

/** A mock trajectories:fuse endpoint that records every request body. */
async function startStepServer(): Promise<StepServer> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      } catch {
        bodies.push({});
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "fused" } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1/fusion/trajectories:fuse`,
    bodies: () => bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

const ROUTES: FusedModelRoute[] = [
  {
    modelId: "fusion-panel",
    name: "default",
    memberEndpointIds: ["gpt", "sonnet"],
    judgeEndpointId: "gpt",
    judgeModelName: "gpt-5.5"
  },
  {
    modelId: "fusion-deep",
    name: "deep",
    memberEndpointIds: ["opus", "gpt"],
    judgeEndpointId: "opus",
    judgeModelName: "claude-opus-4-8",
    synthesizerEndpointId: "opus",
    prompts: { judge_system: "DEEP JUDGE", synthesizer_system: "DEEP SYNTH" }
  }
];

function makeBackend(stepUrl: string, runs: PanelRunInput[]): FusionBackend {
  return new FusionBackend({
    stepUrl,
    runPanels: async (input) => {
      runs.push(input);
      return [candidate("a")];
    },
    defaultModel: "fusion-panel",
    fusedModels: ROUTES,
    passthrough: [{ modelId: "gpt-5.5", endpointId: "gpt", endpointUrl: "http://127.0.0.1:1" }]
  });
}

test("listModelIds advertises the default fused model, other ensembles, then natives", () => {
  const backend = makeBackend("http://127.0.0.1:1/step", []);
  assert.deepEqual(backend.listModelIds(), ["fusion-panel", "fusion-deep", "gpt-5.5"]);
});

test("resolveModel routes fused ids to themselves and unknown ids to the default", () => {
  const backend = makeBackend("http://127.0.0.1:1/step", []);
  assert.equal(backend.resolveModel("fusion-deep"), "fusion-deep");
  // Claude Code's picker sends the claude-prefixed alias; it maps back.
  assert.equal(backend.resolveModel("claude-fusion-deep"), "fusion-deep");
  assert.equal(backend.resolveModel("fusion-panel"), "fusion-panel");
  assert.equal(backend.resolveModel("gpt-5.5"), "gpt-5.5", "natives still proxy");
  assert.equal(backend.resolveModel("something-else"), "fusion-panel");
  assert.equal(backend.resolveModel(undefined), "fusion-panel");
});

test("a named ensemble's turn carries its members, judge, synthesizer, and prompts", async () => {
  const step = await startStepServer();
  try {
    const runs: PanelRunInput[] = [];
    const backend = makeBackend(step.url, runs);
    const res = await backend.chat({ ...userTurn, model: "fusion-deep", stream: false });
    assert.equal(res.status, 200);
    // The panel runner was told which ensemble fans out.
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.ensembleModelId, "fusion-deep");
    // The fuse step routes by the ensemble's endpoint ids and carries its prompts.
    const body = step.bodies()[0] as Record<string, unknown>;
    assert.equal(body.judge_model, "opus");
    assert.equal(body.synthesizer_model, "opus");
    assert.deepEqual(body.prompts, { judge_system: "DEEP JUDGE", synthesizer_system: "DEEP SYNTH" });
  } finally {
    await step.close();
  }
});

test("the default ensemble's turn carries its own judge and no prompts", async () => {
  const step = await startStepServer();
  try {
    const runs: PanelRunInput[] = [];
    const backend = makeBackend(step.url, runs);
    const res = await backend.chat({ ...userTurn, model: "fusion-panel", stream: false });
    assert.equal(res.status, 200);
    assert.equal(runs[0]?.ensembleModelId, "fusion-panel");
    const body = step.bodies()[0] as Record<string, unknown>;
    assert.equal(body.judge_model, "gpt");
    assert.equal(body.synthesizer_model, undefined);
    assert.equal(body.prompts, undefined);
  } finally {
    await step.close();
  }
});

test("an unknown model id falls through to the default ensemble", async () => {
  const step = await startStepServer();
  try {
    const runs: PanelRunInput[] = [];
    const backend = makeBackend(step.url, runs);
    const res = await backend.chat({ ...userTurn, model: "mystery-model", stream: false });
    assert.equal(res.status, 200);
    assert.equal(runs[0]?.ensembleModelId, "fusion-panel");
  } finally {
    await step.close();
  }
});

test("gateway discovery lists every ensemble; Claude discovery aliases them", async () => {
  const backend = makeBackend("http://127.0.0.1:1/step", []);
  const gateway = await startGateway({ backend, host: "127.0.0.1", port: 0 });
  try {
    // OpenAI-shaped discovery (Codex catalog, Cursor picker seeds).
    const openai = (await (await fetch(`${gateway.url()}/v1/models`)).json()) as {
      data: Array<{ id: string }>;
    };
    assert.deepEqual(
      openai.data.map((entry) => entry.id),
      ["fusion-panel", "fusion-deep", "gpt-5.5"]
    );
    // Anthropic-shaped discovery (Claude Code's /model picker): non-Anthropic
    // ids are aliased with a claude- prefix, real id in display_name.
    const anthropic = (await (
      await fetch(`${gateway.url()}/v1/models`, {
        headers: { "anthropic-version": "2023-06-01" }
      })
    ).json()) as { data: Array<{ id: string; display_name: string }> };
    const deep = anthropic.data.find((entry) => entry.display_name === "fusion-deep");
    assert.equal(deep?.id, "claude-fusion-deep");
    // ...and the aliased id routes back to the ensemble (see resolveModel test).
    assert.equal(backend.resolveModel(deep?.id), "fusion-deep");
  } finally {
    await gateway.close();
  }
});

test("two ensembles on the same conversation get distinct sessions and panel runs", async () => {
  const step = await startStepServer();
  try {
    const runs: PanelRunInput[] = [];
    const backend = makeBackend(step.url, runs);
    await backend.chat({ ...userTurn, model: "fusion-panel", stream: false });
    await backend.chat({ ...userTurn, model: "fusion-deep", stream: false });
    // Same conversation prefix, but each ensemble ran its own panel under its
    // own session key (no cross-ensemble candidate reuse).
    assert.equal(runs.length, 2);
    assert.notEqual(runs[0]?.sessionKey, runs[1]?.sessionKey);
    // A repeat on the same ensemble reuses the cached candidates (no new run).
    await backend.chat({ ...userTurn, model: "fusion-deep", stream: false });
    assert.equal(runs.length, 2);
  } finally {
    await step.close();
  }
});
