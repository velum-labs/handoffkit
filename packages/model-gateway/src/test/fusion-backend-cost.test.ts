import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";

import { FusionBackend } from "../fusion-backend.js";
import type { WireTrajectory } from "../fusion-backend.js";
import { InMemorySessionStore } from "../session-store.js";

function candidate(
  modelId: string,
  status = "succeeded",
  extras: Partial<WireTrajectory> = {}
): WireTrajectory {
  return { trajectory_id: `t_${modelId}`, model_id: modelId, status, final_output: "ok", ...extras };
}

type StepServer = { url: string; close: () => Promise<void> };

/** A fuse step that returns a fused completion carrying `usage`. */
async function startStepServer(
  usage: Record<string, number> | undefined,
  providerCost?: Record<string, unknown>
): Promise<StepServer> {
  const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "fused" } }],
      ...(usage !== undefined ? { usage } : {}),
      ...(providerCost !== undefined ? { provider_cost: providerCost } : {})
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1/fusion/trajectories:fuse`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

const turn1 = { messages: [{ role: "user", content: "first task" }], stream: false };

test("WS7: a fused turn meters usage + cost and persists the running session total", async () => {
  const step = await startStepServer({ prompt_tokens: 1000, completion_tokens: 500 });
  const store = new InMemorySessionStore();
  try {
    const backend = new FusionBackend({
      stepUrl: step.url,
      store,
      defaultModel: "fusion-panel",
      costModel: "gpt-5.5",
      runPanels: async () => [candidate("a")]
    });
    await (await backend.chat(turn1)).json();

    const id = store.list()[0]?.id ?? "";
    const cost = store.load(id)?.meta.cost;
    assert.ok(cost !== undefined, "cost was persisted onto the session header");
    // 1000/1e6*1.25 + 500/1e6*10 = 0.00625
    assert.ok(Math.abs(cost.totalUsd - 0.00625) < 1e-9, `expected ~0.00625, got ${cost.totalUsd}`);
    assert.equal(cost.promptTokens, 1000);
    assert.equal(cost.completionTokens, 500);
    assert.equal(cost.meteredTurns, 1);
    assert.equal(cost.unknownCostTurns, 1);
    const ledger = store.load(id)?.costLedger ?? [];
    assert.equal(ledger.length, 2);
    assert.equal(ledger[0]?.stage, "panel");
    assert.equal(ledger[1]?.stage, "judge_synth");
  } finally {
    await step.close();
  }
});

test("WS7: the session total accumulates across turns", async () => {
  const step = await startStepServer({ prompt_tokens: 1000, completion_tokens: 500 });
  const store = new InMemorySessionStore();
  try {
    const backend = new FusionBackend({
      stepUrl: step.url,
      store,
      defaultModel: "fusion-panel",
      costModel: "gpt-5.5",
      runPanels: async () => [candidate("a")]
    });
    await (await backend.chat(turn1)).json();
    // A follow-up user message: same conversation (session key), a new turn.
    const turn2 = {
      messages: [
        { role: "user", content: "first task" },
        { role: "assistant", content: "fused" },
        { role: "user", content: "second task" }
      ],
      stream: false
    };
    await (await backend.chat(turn2)).json();

    const id = store.list()[0]?.id ?? "";
    const cost = store.load(id)?.meta.cost;
    assert.ok(cost !== undefined);
    assert.ok(Math.abs(cost.totalUsd - 0.0125) < 1e-9, `two turns accumulate, got ${cost.totalUsd}`);
    assert.equal(cost.meteredTurns, 2);
    assert.equal(cost.unknownCostTurns, 2);
  } finally {
    await step.close();
  }
});

test("WS7: --budget stops a turn once the session has exceeded the cap", async () => {
  const step = await startStepServer({ prompt_tokens: 1000, completion_tokens: 500 });
  const store = new InMemorySessionStore();
  try {
    // budgetUsd well below one turn's cost (0.00625), so the SECOND turn is refused.
    const backend = new FusionBackend({
      stepUrl: step.url,
      store,
      defaultModel: "fusion-panel",
      costModel: "gpt-5.5",
      budgetUsd: 0.001,
      runPanels: async () => [candidate("a")]
    });
    // Turn 1 runs (the session starts at $0, under budget) and records cost.
    const first = await backend.chat(turn1);
    assert.equal(first.status, 200);
    await first.json();

    // Turn 2: the session has now spent $0.00625 ≥ $0.001 → refused with a clear message.
    const turn2 = {
      messages: [
        { role: "user", content: "first task" },
        { role: "assistant", content: "fused" },
        { role: "user", content: "second task" }
      ],
      stream: false
    };
    const second = await backend.chat(turn2);
    assert.equal(second.status, 402, "budget cap returns a 402 Payment Required");
    const body = (await second.json()) as { error?: { message?: string } };
    assert.match(body.error?.message ?? "", /budget cap reached/);
  } finally {
    await step.close();
  }
});

test("WS7: a fused turn with no usage is metered as unknown-cost (tokens not invented)", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "fused" } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const store = new InMemorySessionStore();
  try {
    const backend = new FusionBackend({
      stepUrl: `http://127.0.0.1:${port}/v1/fusion/trajectories:fuse`,
      store,
      costModel: "gpt-5.5",
      runPanels: async () => [candidate("a")]
    });
    await (await backend.chat(turn1)).json();
    const id = store.list()[0]?.id ?? "";
    const cost = store.load(id)?.meta.cost;
    assert.ok(cost !== undefined);
    assert.equal(cost.totalUsd, 0);
    assert.equal(cost.unknownCostTurns, 2, "usage-less panel and judge entries are flagged, not silently $0");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("full-pipeline metering includes panel candidate usage and local compute estimates", async () => {
  const step = await startStepServer({ prompt_tokens: 1000, completion_tokens: 500 });
  const store = new InMemorySessionStore();
  try {
    const backend = new FusionBackend({
      stepUrl: step.url,
      store,
      defaultModel: "fusion-panel",
      costModel: "gpt-5.5",
      pricing: {
        "mlx-community/Qwen3-1.7B-4bit": { inputPer1mTokens: 0, outputPer1mTokens: 0 }
      },
      localCompute: {
        "mlx-community/Qwen3-1.7B-4bit": { usdPerDeviceHour: 0.36 }
      },
      runPanels: async () => [
        candidate("qwen", "succeeded", {
          model: "mlx-community/Qwen3-1.7B-4bit",
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          metadata: { provider: "openai-compatible", latency_ms: 10_000 }
        })
      ]
    });
    await (await backend.chat(turn1)).json();

    const id = store.list()[0]?.id ?? "";
    const cost = store.load(id)?.meta.cost;
    const ledger = store.load(id)?.costLedger ?? [];
    assert.ok(cost !== undefined);
    assert.equal(ledger.length, 2);
    assert.equal(ledger[0]?.stage, "panel");
    assert.equal(ledger[0]?.localCompute?.activeInferenceMs, 10_000);
    assert.equal(cost.localActiveMs, 10_000);
    assert.ok(Math.abs((cost.localComputeUsd ?? 0) - 0.001) < 1e-9);
    assert.equal(cost.totalTokens, 1650);
  } finally {
    await step.close();
  }
});

test("OpenRouter exact provider cost meters panel and judge entries", async () => {
  const step = await startStepServer(undefined, {
    source: "provider",
    cost_usd: 0.02,
    generation_id: "judge-gen",
    provider_name: "OpenRouter",
    lookup_status: "ok",
    tokens_prompt: 1000,
    tokens_completion: 500
  });
  const store = new InMemorySessionStore();
  try {
    const backend = new FusionBackend({
      stepUrl: step.url,
      store,
      defaultModel: "fusion-panel",
      costModel: "openrouter/auto",
      runPanels: async () => [
        candidate("or-sonnet", "succeeded", {
          metadata: {
            provider: "openrouter",
            provider_cost: {
              source: "provider",
              cost_usd: 0.03,
              generation_id: "panel-gen",
              provider_name: "OpenRouter",
              lookup_status: "ok",
              tokens_prompt: 2000,
              tokens_completion: 1000
            }
          }
        })
      ]
    });

    await (await backend.chat(turn1)).json();

    const id = store.list()[0]?.id ?? "";
    const cost = store.load(id)?.meta.cost;
    const ledger = store.load(id)?.costLedger ?? [];
    assert.ok(cost !== undefined);
    assert.equal(ledger.length, 2);
    assert.equal(ledger[0]?.stage, "panel");
    assert.equal(ledger[0]?.providerCostUsd, 0.03);
    assert.equal(ledger[0]?.providerCost?.generationId, "panel-gen");
    assert.equal(ledger[1]?.stage, "judge_synth");
    assert.equal(ledger[1]?.providerCostUsd, 0.02);
    assert.equal(ledger[1]?.providerCost?.generationId, "judge-gen");
    assert.equal(cost.totalUsd, 0.05);
    assert.equal(cost.providerUsd, 0.05);
    assert.equal(cost.totalTokens, 4500);
    assert.equal(cost.unknownCostEntries, 0);
  } finally {
    await step.close();
  }
});
