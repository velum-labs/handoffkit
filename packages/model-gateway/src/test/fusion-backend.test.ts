import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";

import { FusionBackend } from "../fusion-backend.js";
import type { WireTrajectory } from "../fusion-backend.js";

function candidate(modelId: string, status = "succeeded"): WireTrajectory {
  return { trajectory_id: `t_${modelId}`, model_id: modelId, status, final_output: "ok" };
}

const UNREACHABLE_STEP = "http://127.0.0.1:1/v1/fusion/trajectory:step";

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
    url: `http://127.0.0.1:${port}/v1/fusion/trajectory:step`,
    calls: () => calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

const userTurn = { messages: [{ role: "user", content: "do the task" }] };

test("non-streaming panel failure returns an error and does not cache the session", async () => {
  let panelCalls = 0;
  const backend = new FusionBackend({
    stepUrl: UNREACHABLE_STEP,
    runPanels: async () => {
      panelCalls += 1;
      throw new Error("panel boom");
    }
  });
  const first = await backend.chat({ ...userTurn, stream: false });
  assert.equal(first.status, 502);
  const body = (await first.json()) as { error?: { message?: string } };
  assert.match(body.error?.message ?? "", /panel boom/);

  // The failed session is evicted, so the next turn re-runs the panel.
  const second = await backend.chat({ ...userTurn, stream: false });
  assert.equal(second.status, 502);
  assert.equal(panelCalls, 2);
});

test("non-streaming empty candidates is an error, not a blank success", async () => {
  const backend = new FusionBackend({ stepUrl: UNREACHABLE_STEP, runPanels: async () => [] });
  const res = await backend.chat({ ...userTurn, stream: false });
  assert.equal(res.status, 502);
});

test("non-streaming all-failed candidates is an error", async () => {
  const backend = new FusionBackend({
    stepUrl: UNREACHABLE_STEP,
    runPanels: async () => [candidate("a", "failed"), candidate("b", "failed")]
  });
  const res = await backend.chat({ ...userTurn, stream: false });
  assert.equal(res.status, 502);
});

test("non-streaming success forwards the trajectory:step response and runs panels once", async () => {
  const step = await startStepServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "fused" } }] }));
  });
  try {
    let panelCalls = 0;
    const backend = new FusionBackend({
      stepUrl: step.url,
      runPanels: async () => {
        panelCalls += 1;
        return [candidate("a")];
      }
    });
    const res = await backend.chat({ ...userTurn, stream: false });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    assert.equal(body.choices[0]?.message.content, "fused");

    // A second turn with the same prefix reuses the cached panel run.
    await (await backend.chat({ ...userTurn, stream: false })).json();
    assert.equal(panelCalls, 1);
    assert.equal(step.calls(), 2);
  } finally {
    await step.close();
  }
});

test("non-streaming surfaces a trajectory:step error status", async () => {
  const step = await startStepServer((_req, res) => {
    res.writeHead(500);
    res.end("boom");
  });
  try {
    const backend = new FusionBackend({ stepUrl: step.url, runPanels: async () => [candidate("a")] });
    const res = await backend.chat({ ...userTurn, stream: false });
    assert.equal(res.status, 500);
  } finally {
    await step.close();
  }
});

test("streaming panel failure emits a terminal error event and evicts the session", async () => {
  let panelCalls = 0;
  const backend = new FusionBackend({
    stepUrl: UNREACHABLE_STEP,
    runPanels: async () => {
      panelCalls += 1;
      throw new Error("panel boom");
    }
  });
  const res = await backend.chat({ ...userTurn, stream: true });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /fusion error/);
  assert.match(text, /"finish_reason":"error"/);
  assert.match(text, /\[DONE\]/);

  await (await backend.chat({ ...userTurn, stream: true })).text();
  assert.equal(panelCalls, 2);
});

test("an already-aborted signal aborts the trajectory:step fetch", async () => {
  const backend = new FusionBackend({ stepUrl: UNREACHABLE_STEP, runPanels: async () => [candidate("a")] });
  await assert.rejects(() => backend.chat({ ...userTurn, stream: false }, AbortSignal.abort()));
});

test("expired sessions are evicted so panels re-run after the TTL", async () => {
  const step = await startStepServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });
  try {
    let panelCalls = 0;
    const backend = new FusionBackend({
      stepUrl: step.url,
      sessionTtlMs: 50,
      runPanels: async () => {
        panelCalls += 1;
        return [candidate("a")];
      }
    });
    await (await backend.chat({ ...userTurn, stream: false })).json();
    await (await backend.chat({ ...userTurn, stream: false })).json();
    assert.equal(panelCalls, 1, "within the TTL the panel run is cached");

    await new Promise((resolve) => setTimeout(resolve, 80));
    await (await backend.chat({ ...userTurn, stream: false })).json();
    assert.equal(panelCalls, 2, "after the TTL the session is evicted and panels re-run");
  } finally {
    await step.close();
  }
});

test("the panel re-runs per user turn but is reused within a turn's tool loop", async () => {
  const step = await startStepServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });
  try {
    let panelCalls = 0;
    const turnsSeen: number[] = [];
    const backend = new FusionBackend({
      stepUrl: step.url,
      runPanels: async (input) => {
        panelCalls += 1;
        turnsSeen.push(input.turn);
        return [candidate(`c${input.turn}`)];
      }
    });
    const system = { role: "system", content: "S" };
    const first = { role: "user", content: "task one" };

    // Turn 1: the first user message runs the panel.
    await (await backend.chat({ messages: [system, first], stream: false })).json();
    assert.equal(panelCalls, 1);

    // Internal tool-loop continuation (same user-message count) reuses turn 1.
    await (
      await backend.chat({
        messages: [
          system,
          first,
          { role: "assistant", content: null, tool_calls: [{ id: "t", type: "function" }] },
          { role: "tool", tool_call_id: "t", content: "tool result" }
        ],
        stream: false
      })
    ).json();
    assert.equal(panelCalls, 1, "a tool-loop continuation reuses the turn's candidates");

    // Follow-up user message: a new turn, so the panel runs again.
    await (
      await backend.chat({
        messages: [
          system,
          first,
          { role: "assistant", content: "answer one" },
          { role: "user", content: "task two" }
        ],
        stream: false
      })
    ).json();
    assert.equal(panelCalls, 2, "a follow-up user message re-runs the panel");
    assert.deepEqual(turnsSeen, [1, 2], "each panel run is stamped with its user turn");
  } finally {
    await step.close();
  }
});
