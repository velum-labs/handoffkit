import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";

import { FusionBackend } from "../fusion-backend.js";
import type { WireTrajectory } from "../fusion-backend.js";
import { InMemorySessionStore } from "../session-store.js";

function candidate(modelId: string, status = "succeeded"): WireTrajectory {
  return { trajectory_id: `t_${modelId}`, model_id: modelId, status, final_output: "ok" };
}

const userTurn = { messages: [{ role: "user", content: "do the task" }] };

type StepServer = { url: string; calls: () => number; close: () => Promise<void> };

async function startStepServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<StepServer> {
  let calls = 0;
  const server = createServer((req, res) => {
    calls += 1;
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1/fusion/trajectories:fuse`,
    calls: () => calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

function jsonStep(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "fused" } }] }));
}

test("a turn's conversation + candidates are persisted to the store", async () => {
  const step = await startStepServer(jsonStep);
  const store = new InMemorySessionStore();
  try {
    let panelCalls = 0;
    const backend = new FusionBackend({
      stepUrl: step.url,
      store,
      sessionMeta: { tool: "codex", models: [{ id: "a", model: "model-a" }] },
      runPanels: async () => {
        panelCalls += 1;
        return [candidate("a")];
      }
    });
    await (await backend.chat({ ...userTurn, stream: false })).json();

    const sessions = store.list();
    assert.equal(sessions.length, 1, "one session was persisted");
    const persisted = store.load(sessions[0]?.id ?? "");
    assert.ok(persisted !== undefined);
    assert.equal(persisted.meta.tool, "codex");
    assert.equal(persisted.turns.length, 1, "the resolved turn was written through");
    assert.equal(persisted.turns[0]?.turn, 1);
    assert.equal(persisted.turns[0]?.candidates[0]?.model_id, "a");
    assert.deepEqual(persisted.turns[0]?.messages, userTurn.messages);
    assert.equal(panelCalls, 1);
  } finally {
    await step.close();
  }
});

test("a failed turn is not persisted (failures are never cached)", async () => {
  const store = new InMemorySessionStore();
  const backend = new FusionBackend({
    stepUrl: "http://127.0.0.1:1/v1/fusion/trajectories:fuse",
    store,
    runPanels: async () => {
      throw new Error("panel boom");
    }
  });
  const res = await backend.chat({ ...userTurn, stream: false });
  assert.equal(res.status, 502);
  // The meta header exists, but no turn was recorded for the failed panel run.
  const sessions = store.list();
  assert.equal(sessions[0]?.turnCount, 0);
});

test("a fresh backend instance resumes a persisted session: stable id, no panel re-run", async () => {
  const step = await startStepServer(jsonStep);
  const store = new InMemorySessionStore();
  try {
    // First process: run a turn so candidates are persisted.
    let firstPanelCalls = 0;
    const first = new FusionBackend({
      stepUrl: step.url,
      store,
      sessionMeta: { tool: "codex" },
      runPanels: async () => {
        firstPanelCalls += 1;
        return [candidate("a")];
      }
    });
    await (await first.chat({ ...userTurn, stream: false })).json();
    assert.equal(firstPanelCalls, 1);
    const sessionId = store.list()[0]?.id ?? "";
    assert.notEqual(sessionId, "");

    // Second process: a brand-new backend (empty in-memory cache) resumes the
    // stored session id and replays the same conversation. The panel must NOT
    // re-run — the candidates are rehydrated from the store.
    let secondPanelCalls = 0;
    const second = new FusionBackend({
      stepUrl: step.url,
      store,
      resumeId: sessionId,
      runPanels: async () => {
        secondPanelCalls += 1;
        return [candidate("a")];
      }
    });
    await (await second.chat({ ...userTurn, stream: false })).json();
    assert.equal(secondPanelCalls, 0, "the resumed turn replays cached candidates");
    // No new session was created — the id stayed stable.
    assert.equal(store.list().length, 1, "resume reuses the session id, not a new one");
    assert.equal(store.list()[0]?.id, sessionId);
  } finally {
    await step.close();
  }
});

test("a missing --resume target falls back to a fresh session", async () => {
  const step = await startStepServer(jsonStep);
  const store = new InMemorySessionStore();
  try {
    let panelCalls = 0;
    const backend = new FusionBackend({
      stepUrl: step.url,
      store,
      resumeId: "does-not-exist",
      runPanels: async () => {
        panelCalls += 1;
        return [candidate("a")];
      }
    });
    await (await backend.chat({ ...userTurn, stream: false })).json();
    assert.equal(panelCalls, 1, "a missing resume target runs the panel fresh");
    assert.equal(store.list().length, 1);
  } finally {
    await step.close();
  }
});

test("an identical fresh opener after TTL gets a new isolated session", async () => {
  const step = await startStepServer(jsonStep);
  const store = new InMemorySessionStore();
  try {
    let panelCalls = 0;
    // A short in-memory TTL ends the live-conversation identity. A new request
    // with no assistant turn is a fresh opener, even when its text is identical
    // to an old conversation; it must not inherit cached candidates or cost.
    const backend = new FusionBackend({
      stepUrl: step.url,
      store,
      sessionTtlMs: 30,
      runPanels: async () => {
        panelCalls += 1;
        return [candidate("a")];
      }
    });
    await (await backend.chat({ ...userTurn, stream: false })).json();
    assert.equal(panelCalls, 1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await (await backend.chat({ ...userTurn, stream: false })).json();
    assert.equal(panelCalls, 2, "the fresh opener runs its own panel");
    assert.equal(store.list().length, 2, "the fresh opener mints a new session id");
  } finally {
    await step.close();
  }
});

test("without a store, behaviour is unchanged (panels re-run after the TTL)", async () => {
  const step = await startStepServer(jsonStep);
  try {
    let panelCalls = 0;
    const backend = new FusionBackend({
      stepUrl: step.url,
      sessionTtlMs: 30,
      runPanels: async () => {
        panelCalls += 1;
        return [candidate("a")];
      }
    });
    await (await backend.chat({ ...userTurn, stream: false })).json();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await (await backend.chat({ ...userTurn, stream: false })).json();
    assert.equal(panelCalls, 2, "no store means the TTL eviction re-runs the panel");
  } finally {
    await step.close();
  }
});
