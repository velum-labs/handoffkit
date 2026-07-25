import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";

import { FusionBackend } from "../fusion-backend.js";
import type { WireTrajectory } from "../fusion-backend.js";
import {
  AnthropicBackend,
  REASONING_SELECTION,
  anthropicToChat,
  reasoningSelectionOf,
  startGateway
} from "@velum-labs/routekit-gateway";
import type { PanelRunInput } from "../fusion-backend.js";

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
      { routekitModelId: "codex/gpt-5.5", routekitUrl: "http://127.0.0.1:1" },
      { routekitModelId: "claude-code/claude-opus-4-8", routekitUrl: "http://127.0.0.1:1" }
    ]
  });
  assert.deepEqual(backend.listModelIds(), [
    "fusion-panel",
    "codex/gpt-5.5",
    "claude-code/claude-opus-4-8"
  ]);
});

test("resolveModel keeps a RouteKit model id but folds fusion/unknown ids to the default", () => {
  const backend = new FusionBackend({
    stepUrl: UNREACHABLE_STEP,
    runPanels: async () => [candidate("a")],
    defaultModel: "fusion-panel",
    passthrough: [{ routekitModelId: "codex/gpt-5.5", routekitUrl: "http://127.0.0.1:1" }]
  });
  assert.equal(backend.resolveModel("codex/gpt-5.5"), "codex/gpt-5.5");
  assert.equal(
    backend.resolveModel("claude-codex/gpt-5.5"),
    "codex/gpt-5.5",
    "the Claude-aliased RouteKit id resolves too"
  );
  assert.equal(backend.resolveModel("fusion-panel"), "fusion-panel");
  assert.equal(backend.resolveModel("claude-fusion-panel"), "fusion-panel", "the claude fusion alias fuses");
  assert.equal(backend.resolveModel(undefined), "fusion-panel");
});

test("reasoningWireShape reports fused and inventory-authored passthrough wire shapes", () => {
  const backend = new FusionBackend({
    stepUrl: UNREACHABLE_STEP,
    runPanels: async () => [candidate("a")],
    defaultModel: "fusion-panel",
    fusedModels: [{
      modelId: "fusion-mini",
      name: "mini",
      memberRoutekitModelIds: ["openai/member"]
    }],
    passthrough: [
      {
        routekitModelId: "arbitrary-coding-model",
        routekitUrl: "http://127.0.0.1:1",
        reasoningWireShape: "openai-responses"
      },
      {
        routekitModelId: "openai/member",
        routekitUrl: "http://127.0.0.1:1",
        reasoningWireShape: "openai-chat"
      },
      { routekitModelId: "looks-like-codex", routekitUrl: "http://127.0.0.1:1" }
    ]
  });
  assert.equal(backend.reasoningWireShape("fusion-mini"), "routekit-envelope");
  assert.equal(backend.reasoningWireShape("claude-fusion-mini"), "routekit-envelope");
  assert.equal(
    backend.reasoningWireShape("fusion-panel"),
    "routekit-envelope",
    "the implicit default dispatches through #defaultRoute even when its id is not explicit"
  );
  assert.equal(backend.reasoningWireShape("claude-fusion-panel"), "routekit-envelope");
  assert.equal(backend.reasoningWireShape("arbitrary-coding-model"), "openai-responses");
  assert.equal(backend.reasoningWireShape("openai/member"), "openai-chat");
  assert.equal(backend.reasoningWireShape("looks-like-codex"), undefined);
  assert.equal(backend.reasoningWireShape("unknown"), undefined);
});

test("servesModel distinguishes gateway-served ids from unknown ids (no default fold)", () => {
  const backend = new FusionBackend({
    stepUrl: UNREACHABLE_STEP,
    runPanels: async () => [candidate("a")],
    defaultModel: "fusion-panel",
    passthrough: [{ routekitModelId: "codex/gpt-5.5", routekitUrl: "http://127.0.0.1:1" }]
  });
  assert.equal(backend.servesModel("fusion-panel"), true);
  assert.equal(backend.servesModel("codex/gpt-5.5"), true);
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
      passthrough: [{ routekitModelId: "codex/gpt-5.5", routekitUrl: chat.baseUrl }]
    });
    // Claude Code selects the aliased id from its picker and sends it verbatim.
    const res = await backend.chat({ ...userTurn, model: "claude-codex/gpt-5.5", stream: false });
    assert.equal(res.status, 200);
    assert.equal(panelCalls, 0, "the aliased native skips the fusion panel");
    assert.equal((chat.lastBody() as { model?: string }).model, "codex/gpt-5.5");
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
      passthrough: [{ routekitModelId: "codex/gpt-5.5", routekitUrl: chat.baseUrl }]
    });
    const res = await backend.chat({ ...userTurn, model: "codex/gpt-5.5", stream: false });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    assert.equal(body.choices[0]?.message.content, "native answer");
    assert.equal(panelCalls, 0, "selecting a native model skips the fusion panel");
    assert.equal(chat.calls(), 1);
    const sent = chat.lastBody() as { model?: string };
    assert.equal(sent.model, "codex/gpt-5.5");
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
      passthrough: [{ routekitModelId: "codex/gpt-5.5", routekitUrl: chat.baseUrl }]
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
      { routekitModelId: "claude-code/claude-opus-4-8", routekitUrl: "http://127.0.0.1:1" },
      { routekitModelId: "codex/gpt-5.5", routekitUrl: "http://127.0.0.1:1" }
    ]
  });
  const gateway = await startGateway({ backend, host: "127.0.0.1", port: 0 });
  try {
    const openai = (await (await fetch(`${gateway.url()}/v1/models`)).json()) as {
      data: Array<{ id: string }>;
    };
    assert.deepEqual(
      openai.data.map((entry) => entry.id),
      ["fusion-panel", "claude-code/claude-opus-4-8", "codex/gpt-5.5"]
    );

    const anthropic = (await (
      await fetch(`${gateway.url()}/v1/models`, { headers: { "anthropic-version": "2023-06-01" } })
    ).json()) as { data: Array<{ id: string; display_name: string }> };
    // Anthropic discovery aliases every model past Claude Code's picker filter:
    // the claude-family native as-is, the non-Anthropic one under a claude- alias.
    assert.ok(anthropic.data.some((entry) => entry.id === "claude-code/claude-opus-4-8"));
    const gpt = anthropic.data.find((entry) => entry.id === "claude-codex/gpt-5.5");
    assert.equal(gpt?.display_name, "codex/gpt-5.5");
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
    passthrough: [{ routekitModelId: "codex/gpt-5.5", routekitUrl: "http://127.0.0.1:1" }]
  });
  const body = (await (await backend.models()).json()) as { data: Array<{ id: string }> };
  assert.deepEqual(
    body.data.map((entry) => entry.id),
    ["fusion-panel", "codex/gpt-5.5"]
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
      sessionTtlMs: 500,
      runPanels: async () => {
        panelCalls += 1;
        return [candidate("a")];
      }
    });
    await (await backend.chat({ ...userTurn, stream: false })).json();
    await (await backend.chat({ ...userTurn, stream: false })).json();
    assert.equal(panelCalls, 1, "within the TTL the panel run is cached");

    await new Promise((resolve) => setTimeout(resolve, 600));
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


test("Fusion ingress rejects malformed reasoning controls before any work", async () => {
  const invalid = [
    [{ mode: "future" }, /mode is unsupported/],
    [{ mode: "effort" }, /effort must be a non-empty string/],
    [{ mode: "effort", effort: "" }, /effort must be a non-empty string/],
    [{ mode: "budget", budgetTokens: 0 }, /budgetTokens must be a positive integer/],
    [{ mode: "budget", budgetTokens: 1.5 }, /budgetTokens must be a positive integer/]
  ] as const;
  let panelCalls = 0;
  let stepCalls = 0;
  const backend = new FusionBackend({
    stepUrl: UNREACHABLE_STEP,
    defaultModel: "fusion-panel",
    runPanels: async () => { panelCalls += 1; return [candidate("a")]; },
    runFuseStep: async () => {
      stepCalls += 1;
      return Response.json({ choices: [{ message: { role: "assistant", content: "fused" } }] });
    }
  });
  for (const [selection, expected] of invalid) {
    const direct = await backend.chat({
      model: "fusion-panel",
      messages: [{ role: "user", content: "solve" }],
      x_routekit: { version: 1, selection }
    });
    assert.equal(direct.status, 400);
    const error = (await direct.json()) as { error: { code: string; type: string; message: string } };
    assert.equal(error.error.code, "invalid_reasoning_control");
    assert.equal(error.error.type, "invalid_request_error");
    assert.match(error.error.message, expected);
  }
  const symbolBody: Record<PropertyKey, unknown> = {
    model: "fusion-panel",
    messages: [{ role: "user", content: "solve" }]
  };
  Object.defineProperty(symbolBody, REASONING_SELECTION, {
    value: { mode: "budget", budgetTokens: -1 },
    enumerable: true
  });
  const symbolResponse = await backend.chat(symbolBody);
  assert.equal(symbolResponse.status, 400);
  const metadataResponse = await backend.chat({
    model: "fusion-panel",
    messages: [{ role: "user", content: "solve" }],
    x_routekit: {
      version: 1,
      responses: { items: [null], includeEncryptedContent: true }
    }
  });
  assert.equal(metadataResponse.status, 400);
  assert.equal(
    ((await metadataResponse.json()) as { error: { code: string } }).error.code,
    "invalid_reasoning_metadata"
  );
  const nestedMetadataResponse = await backend.chat({
    model: "fusion-panel",
    messages: [{
      role: "assistant",
      content: "prior",
      x_routekit: { version: 1, google: { toolCallIndexes: { call_1: -1 } } }
    }]
  });
  assert.equal(nestedMetadataResponse.status, 400);
  const nestedError = (await nestedMetadataResponse.json()) as { error: { code: string; param: string } };
  assert.equal(nestedError.error.code, "invalid_reasoning_metadata");
  assert.equal(nestedError.error.param, "messages[0].x_routekit.google.toolCallIndexes");
  assert.equal(panelCalls, 0);
  assert.equal(stepCalls, 0);

  for (const selection of [
    { mode: "auto" },
    { mode: "disabled" },
    { mode: "adaptive" },
    { mode: "effort", effort: "high" },
    { mode: "budget", budgetTokens: 2048 }
  ] as const) {
    const response = await backend.chat({
      model: "fusion-panel",
      messages: [{ role: "user", content: "solve" }],
      x_routekit: { version: 1, selection }
    });
    assert.equal(response.status, 200);
  }
  assert.equal(panelCalls, 1, "same-turn valid retries reuse the cached panel");
  assert.equal(stepCalls, 5);

  const gateway = await startGateway({ backend, host: "127.0.0.1", port: 0 });
  try {
    const external = await fetch(`${gateway.url()}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "fusion-panel",
        messages: [{ role: "user", content: "solve" }],
        x_routekit: { version: 1, selection: { mode: "effort" } }
      })
    });
    assert.equal(external.status, 400);
    const error = (await external.json()) as { error: { code: string } };
    assert.equal(error.error.code, "invalid_reasoning_control");
    assert.equal(panelCalls, 1);
    assert.equal(stepCalls, 5);
  } finally {
    await gateway.close();
  }
});

test("fused steps preserve every Anthropic reasoning mode in the serializable envelope", async () => {
  const cases = [
    {
      thinking: { type: "enabled" as const, budget_tokens: 2048 },
      expected: { mode: "budget", budgetTokens: 2048 }
    },
    {
      thinking: { type: "adaptive" as const, display: "omitted" as const },
      expected: { mode: "adaptive" }
    },
    {
      thinking: { type: "disabled" as const },
      expected: { mode: "disabled" }
    }
  ];
  for (const item of cases) {
    let panelInput: PanelRunInput | undefined;
    let stepBody: Record<string, unknown> | undefined;
    const backend = new FusionBackend({
      stepUrl: UNREACHABLE_STEP,
      defaultModel: "fusion-panel",
      runPanels: async (input) => {
        panelInput = input;
        return [candidate("a")];
      },
      runFuseStep: async (request) => {
        stepBody = JSON.parse(request.body) as Record<string, unknown>;
        return Response.json({ choices: [{ message: { role: "assistant", content: "fused" } }] });
      }
    });
    const chat = anthropicToChat(
      {
        model: "claude-client",
        max_tokens: 4096,
        thinking: item.thinking,
        messages: [{ role: "user", content: "solve" }]
      },
      "fusion-panel"
    );
    const response = await backend.chat(chat);
    assert.equal(response.status, 200);
    assert.deepEqual(panelInput?.reasoningSelection, item.expected);
    assert.deepEqual(reasoningSelectionOf(stepBody), item.expected);
    assert.deepEqual(
      (stepBody?.x_routekit as { anthropic?: { request?: { thinking?: unknown } } })
        .anthropic?.request?.thinking,
      item.thinking
    );
  }
});

test("fused Responses emits new synthesizer encrypted reasoning buffered and streamed", async () => {
  for (const streaming of [false, true]) {
    const items = streaming
      ? [
          { type: "reasoning", id: "rs_synth_stream_a", encrypted_content: "synth-stream-cipher-a" },
          { type: "reasoning", id: "rs_synth_stream_b", encrypted_content: "synth-stream-cipher-b" }
        ]
      : [{ type: "reasoning", id: "rs_synth_buffered", encrypted_content: "synth-buffered-cipher" }];
    const envelope = {
      version: 1 as const,
      responses: { items, includeEncryptedContent: true }
    };
    let stepBody: Record<string, unknown> | undefined;
    const backend = new FusionBackend({
      stepUrl: UNREACHABLE_STEP,
      defaultModel: "fusion-panel",
      runPanels: async () => [candidate("a")],
      runFuseStep: async (request) => {
        stepBody = JSON.parse(request.body) as Record<string, unknown>;
        if (!request.streaming) {
          return Response.json({
            choices: [{
              message: { role: "assistant", content: "fused answer", x_routekit: envelope },
              finish_reason: "stop"
            }]
          });
        }
        const encoder = new TextEncoder();
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            for (const data of [
              { choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
              ...(streaming
                ? items.map((item) => ({
                    choices: [{
                      index: 0,
                      delta: {
                        x_routekit: {
                          version: 1,
                          responses: { items: [item], includeEncryptedContent: true }
                        }
                      },
                      finish_reason: null
                    }]
                  }))
                : [{ choices: [{ index: 0, delta: { x_routekit: envelope }, finish_reason: null }] }]),
              { choices: [{ index: 0, delta: { content: "fused answer" }, finish_reason: null }] },
              { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
            ]) controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          }
        }), { headers: { "content-type": "text/event-stream" } });
      }
    });
    const gateway = await startGateway({ backend, host: "127.0.0.1", port: 0 });
    try {
      const response = await fetch(`${gateway.url()}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fusion-panel",
          input: "solve",
          include: ["reasoning.encrypted_content"],
          stream: streaming
        })
      });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      assert.deepEqual(
        (stepBody?.x_routekit as { responses?: { includeEncryptedContent?: boolean } })
          ?.responses?.includeEncryptedContent,
        true
      );
      const ciphers = streaming
        ? ["synth-stream-cipher-a", "synth-stream-cipher-b"]
        : ["synth-buffered-cipher"];
      for (const cipher of ciphers) assert.equal(text.includes(cipher), true);
      if (streaming) {
        assert.equal(text.indexOf(ciphers[0] ?? "") < text.indexOf(ciphers[1] ?? ""), true);
      }
      assert.equal(text.indexOf('"type":"reasoning"') < text.indexOf("fused answer"), true);
      const outputText = streaming
        ? [...text.matchAll(/"delta":"([^"]*)"/g)].map((match) => match[1]).join("")
        : String(((JSON.parse(text) as { output: Array<{ type: string; content?: Array<{ text?: string }> }> })
            .output.find((item) => item.type === "message")?.content?.[0]?.text));
      for (const cipher of ciphers) assert.equal(outputText.includes(cipher), false);
    } finally {
      await gateway.close();
    }
  }
});


test("signed and redacted Anthropic history survives fused and passthrough JSON hops", async () => {
  const source = anthropicToChat(
    {
      model: "claude-client",
      max_tokens: 4096,
      thinking: { type: "adaptive", display: "omitted" },
      output_config: { effort: "xhigh", vendor_hint: "exact" },
      messages: [
        { role: "user", content: "continue" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private", signature: "sig-valid" },
            { type: "redacted_thinking", data: "opaque-redacted" },
            { type: "tool_use", id: "tool_1", name: "read", input: { path: "a.ts" } }
          ]
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_1", content: "source" }] }
      ]
    },
    "fusion-panel"
  );

  let stepBody: Record<string, unknown> | undefined;
  const fused = new FusionBackend({
    stepUrl: UNREACHABLE_STEP,
    defaultModel: "fusion-panel",
    runPanels: async () => [candidate("a")],
    runFuseStep: async (request) => {
      stepBody = JSON.parse(request.body) as Record<string, unknown>;
      return Response.json({ choices: [{ message: { role: "assistant", content: "fused" } }] });
    }
  });
  assert.equal((await fused.chat(source)).status, 200);

  let providerRequest: Request | undefined;
  const anthropic = new AnthropicBackend({
    baseUrl: "https://api.anthropic.test/v1",
    apiKey: "secret",
    defaultModel: "claude-native",
    transport: async (input, init) => {
      providerRequest = new Request(input, init);
      return Response.json({ content: [{ type: "text", text: "done" }], stop_reason: "end_turn" });
    }
  });
  assert.equal((await anthropic.chat(stepBody)).status, 200);
  const outbound = (await providerRequest?.json()) as {
    thinking?: unknown;
    output_config?: unknown;
    messages: Array<{ content: Array<Record<string, unknown>> }>;
  };
  assert.deepEqual(outbound.thinking, { type: "adaptive", display: "omitted" });
  assert.deepEqual(outbound.output_config, { effort: "xhigh", vendor_hint: "exact" });
  assert.deepEqual(outbound.messages[1]?.content.map((block) => block.type), [
    "thinking",
    "redacted_thinking",
    "tool_use"
  ]);
  assert.equal(outbound.messages[1]?.content[0]?.signature, "sig-valid");
  assert.equal(outbound.messages[1]?.content[1]?.data, "opaque-redacted");

  const passthrough = await startChatServer();
  try {
    const proxy = new FusionBackend({
      stepUrl: UNREACHABLE_STEP,
      defaultModel: "fusion-panel",
      runPanels: async () => [candidate("a")],
      passthrough: [{ routekitModelId: "claude-native", routekitUrl: passthrough.baseUrl }]
    });
    assert.equal(
      (await proxy.chat({ ...source, model: "claude-native" })).status,
      200
    );
    const serialized = passthrough.lastBody() as {
      x_routekit?: unknown;
      messages?: Array<{ x_routekit?: unknown }>;
    };
    assert.ok(serialized.x_routekit, "passthrough intentionally retains the namespaced envelope");
    assert.ok(serialized.messages?.[1]?.x_routekit, "assistant history retains its namespaced envelope");
  } finally {
    await passthrough.close();
  }
});
