import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";

import { FusionBackend } from "../fusion-backend.js";
import type { WireTrajectory } from "../fusion-backend.js";
import { startGateway } from "../server.js";

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

type ChatServer = { baseUrl: string; calls: () => number; lastBody: () => unknown; close: () => Promise<void> };

/** A mock OpenAI-compatible router endpoint for native passthrough tests. */
async function startChatServer(): Promise<ChatServer> {
  let calls = 0;
  let lastBody: unknown;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      calls += 1;
      try {
        lastBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        lastBody = undefined;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "native answer" } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls: () => calls,
    lastBody: () => lastBody,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

test("listModelIds advertises the fused model first, then each native model", () => {
  const backend = new FusionBackend({
    stepUrl: UNREACHABLE_STEP,
    runPanels: async () => [candidate("a")],
    defaultModel: "fusion-panel",
    passthrough: [
      { modelId: "gpt-5.5", endpointId: "codex", endpointUrl: "http://127.0.0.1:1" },
      { modelId: "claude-opus-4-8", endpointId: "claude-code", endpointUrl: "http://127.0.0.1:1" }
    ]
  });
  assert.deepEqual(backend.listModelIds(), ["fusion-panel", "gpt-5.5", "claude-opus-4-8"]);
});

test("resolveModel keeps a native id but folds fusion/unknown ids to the default", () => {
  const backend = new FusionBackend({
    stepUrl: UNREACHABLE_STEP,
    runPanels: async () => [candidate("a")],
    defaultModel: "fusion-panel",
    passthrough: [{ modelId: "gpt-5.5", endpointId: "codex", endpointUrl: "http://127.0.0.1:1" }]
  });
  assert.equal(backend.resolveModel("gpt-5.5"), "gpt-5.5");
  assert.equal(backend.resolveModel("codex"), "gpt-5.5", "an endpoint id resolves to the native model too");
  assert.equal(backend.resolveModel("claude-gpt-5.5"), "gpt-5.5", "the claude-aliased native id resolves too");
  assert.equal(backend.resolveModel("fusion-panel"), "fusion-panel");
  assert.equal(backend.resolveModel("claude-fusion-panel"), "fusion-panel", "the claude fusion alias fuses");
  assert.equal(backend.resolveModel(undefined), "fusion-panel");
});

test("servesModel distinguishes gateway-served ids from unknown ids (no default fold)", () => {
  const backend = new FusionBackend({
    stepUrl: UNREACHABLE_STEP,
    runPanels: async () => [candidate("a")],
    defaultModel: "fusion-panel",
    passthrough: [{ modelId: "gpt-5.5", endpointId: "codex", endpointUrl: "http://127.0.0.1:1" }]
  });
  assert.equal(backend.servesModel("fusion-panel"), true);
  assert.equal(backend.servesModel("gpt-5.5"), true);
  assert.equal(backend.servesModel("codex"), true, "the endpoint id is served too");
  // Unknown ids are NOT claimed: the gateway can relay them (e.g. a Codex
  // client's stock model pick) instead of silently fusing.
  assert.equal(backend.servesModel("gpt-5.3-codex"), false);
});

test("a claude-aliased native model proxies to its provider (Claude picker path)", async () => {
  const chat = await startChatServer();
  try {
    let panelCalls = 0;
    const backend = new FusionBackend({
      stepUrl: UNREACHABLE_STEP,
      runPanels: async () => {
        panelCalls += 1;
        return [candidate("a")];
      },
      defaultModel: "fusion-panel",
      passthrough: [{ modelId: "gpt-5.5", endpointId: "codex", endpointUrl: chat.baseUrl }]
    });
    // Claude Code selects the aliased id from its picker and sends it verbatim.
    const res = await backend.chat({ ...userTurn, model: "claude-gpt-5.5", stream: false });
    assert.equal(res.status, 200);
    assert.equal(panelCalls, 0, "the aliased native skips the fusion panel");
    assert.equal((chat.lastBody() as { model?: string }).model, "codex");
  } finally {
    await chat.close();
  }
});

test("a native model is proxied to its provider verbatim and never runs the panel", async () => {
  const chat = await startChatServer();
  try {
    let panelCalls = 0;
    const backend = new FusionBackend({
      stepUrl: UNREACHABLE_STEP,
      runPanels: async () => {
        panelCalls += 1;
        return [candidate("a")];
      },
      defaultModel: "fusion-panel",
      passthrough: [{ modelId: "gpt-5.5", endpointId: "codex", endpointUrl: chat.baseUrl }]
    });
    const res = await backend.chat({ ...userTurn, model: "gpt-5.5", stream: false });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    assert.equal(body.choices[0]?.message.content, "native answer");
    assert.equal(panelCalls, 0, "selecting a native model skips the fusion panel");
    assert.equal(chat.calls(), 1);
    const sent = chat.lastBody() as { model?: string };
    assert.equal(sent.model, "codex", "the request's model is rewritten to the router endpoint id");
  } finally {
    await chat.close();
  }
});

test("the fused model still runs the panel when natives are also configured", async () => {
  const chat = await startChatServer();
  const step = await startStepServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "fused" } }] }));
  });
  try {
    let panelCalls = 0;
    const backend = new FusionBackend({
      stepUrl: step.url,
      runPanels: async () => {
        panelCalls += 1;
        return [candidate("a")];
      },
      defaultModel: "fusion-panel",
      passthrough: [{ modelId: "gpt-5.5", endpointId: "codex", endpointUrl: chat.baseUrl }]
    });
    const res = await backend.chat({ ...userTurn, model: "fusion-panel", stream: false });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    assert.equal(body.choices[0]?.message.content, "fused");
    assert.equal(panelCalls, 1);
    assert.equal(chat.calls(), 0, "the native provider is not touched for a fused request");
  } finally {
    await step.close();
    await chat.close();
  }
});

test("the gateway serves native+fusion discovery in both OpenAI and Anthropic shapes", async () => {
  const backend = new FusionBackend({
    stepUrl: UNREACHABLE_STEP,
    runPanels: async () => [candidate("a")],
    defaultModel: "fusion-panel",
    passthrough: [
      { modelId: "claude-opus-4-8", endpointId: "claude-code", endpointUrl: "http://127.0.0.1:1" },
      { modelId: "gpt-5.5", endpointId: "codex", endpointUrl: "http://127.0.0.1:1" }
    ]
  });
  const gateway = await startGateway({ backend, host: "127.0.0.1", port: 0 });
  try {
    const openai = (await (await fetch(`${gateway.url()}/v1/models`)).json()) as {
      data: Array<{ id: string }>;
    };
    assert.deepEqual(
      openai.data.map((entry) => entry.id),
      ["fusion-panel", "claude-opus-4-8", "gpt-5.5"]
    );

    const anthropic = (await (
      await fetch(`${gateway.url()}/v1/models`, { headers: { "anthropic-version": "2023-06-01" } })
    ).json()) as { data: Array<{ id: string; display_name: string }> };
    // Anthropic discovery aliases every model past Claude Code's picker filter:
    // the claude-family native as-is, the non-Anthropic one under a claude- alias.
    assert.ok(anthropic.data.some((entry) => entry.id === "claude-opus-4-8"));
    const gpt = anthropic.data.find((entry) => entry.id === "claude-gpt-5.5");
    assert.equal(gpt?.display_name, "gpt-5.5");
    assert.ok(anthropic.data.every((entry) => entry.id.startsWith("claude") || entry.id.startsWith("anthropic")));
  } finally {
    await gateway.close();
  }
});

test("models() returns the OpenAI-shaped multi-model discovery list", async () => {
  const backend = new FusionBackend({
    stepUrl: UNREACHABLE_STEP,
    runPanels: async () => [candidate("a")],
    defaultModel: "fusion-panel",
    passthrough: [{ modelId: "gpt-5.5", endpointId: "codex", endpointUrl: "http://127.0.0.1:1" }]
  });
  const body = (await (await backend.models()).json()) as { data: Array<{ id: string }> };
  assert.deepEqual(
    body.data.map((entry) => entry.id),
    ["fusion-panel", "gpt-5.5"]
  );
});

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

test("a harness-injected subagent notification continues the turn instead of fanning out a new panel", async () => {
  const tasksSeen: string[] = [];
  const step = await startStepServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    })();
  });
  try {
    let panelCalls = 0;
    const backend = new FusionBackend({
      stepUrl: step.url,
      runPanels: async (input) => {
        panelCalls += 1;
        tasksSeen.push(input.task);
        return [candidate("a")];
      }
    });
    const system = { role: "system", content: "S" };
    const first = { role: "user", content: "spawn a sub-agent and ask it to say OK" };
    await (await backend.chat({ messages: [system, first], stream: false })).json();
    assert.equal(panelCalls, 1);

    // Codex delivers the spawned sub-agent's completion as a *user* message.
    // It must not count as a new user turn (no second panel fanout), and it
    // must never become a panel task.
    const notification = {
      role: "user",
      content: '<subagent_notification>\n{"agent_path":"abc","status":{"completed":"OK"}}\n</subagent_notification>'
    };
    await (
      await backend.chat({
        messages: [
          system,
          first,
          { role: "assistant", content: "spawned" },
          notification
        ],
        stream: false
      })
    ).json();
    assert.equal(panelCalls, 1, "a subagent notification reuses the turn's cached candidates");
    assert.deepEqual(tasksSeen, ["spawn a sub-agent and ask it to say OK"]);
  } finally {
    await step.close();
  }
});
