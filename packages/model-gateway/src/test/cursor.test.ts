/**
 * Tests for the Cursor BYOK shim: the pure Responses-hybrid translation in
 * `adapters/cursor.ts` plus the `/v1/cursor/*` routes that delegate into the
 * regular chat-completions paths of both gateways. Mirrors the Python
 * `test_cursor_endpoint.py` suite.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { isCursorChatBody, translateCursorRequest } from "../adapters/cursor.js";
import { startFusionGateway } from "../fusion-gateway.js";
import type { FrontDoorRunner } from "../fusion-gateway.js";
import { startGateway } from "../server.js";
import type { Backend } from "../backend.js";

// The documented Cursor agent-mode request: a Responses-API body POSTed to a
// chat-completions path (Cursor's known BYOK hybrid).
const AGENT_MODE_BODY: Record<string, unknown> = {
  model: "gpt-5.5",
  input: [
    { type: "message", role: "developer", content: "You are a coding agent." },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "fix the bug" }]
    },
    { type: "reasoning", encrypted_content: "opaque-blob" },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Reading the file." }]
    },
    {
      type: "function_call",
      call_id: "call_1",
      name: "read_file",
      arguments: '{"path": "a.py"}'
    },
    { type: "function_call_output", call_id: "call_1", output: "print('hi')" }
  ],
  stream: true,
  store: false,
  include: ["reasoning.encrypted_content"],
  reasoning: { effort: "medium", summary: "auto" },
  text: { verbosity: "low" },
  stream_options: { include_usage: true },
  tools: [
    {
      type: "function",
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } }
    },
    { type: "custom", name: "ApplyPatch", description: "Apply a patch", format: {} }
  ],
  tool_choice: "auto",
  max_output_tokens: 4096,
  temperature: 0.2
};

// ---- pure translation ----

test("translate maps the full agent-mode payload", () => {
  const translated = translateCursorRequest(AGENT_MODE_BODY);

  assert.equal(translated.model, "gpt-5.5");
  assert.equal(translated.stream, true);
  assert.equal(translated.temperature, 0.2);
  assert.equal(translated.tool_choice, "auto");
  assert.equal(translated.max_tokens, 4096);
  assert.deepEqual(translated.messages, [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: "fix the bug" },
    {
      role: "assistant",
      content: "Reading the file.",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "read_file", arguments: '{"path": "a.py"}' }
        }
      ]
    },
    { role: "tool", tool_call_id: "call_1", content: "print('hi')" }
  ]);
  // Responses-only fields must never survive translation (stream_options is re-added for metering).
  for (const stripped of [
    "input",
    "store",
    "include",
    "reasoning",
    "text",
    "max_output_tokens"
  ]) {
    assert.equal(stripped in translated, false, `${stripped} must be stripped`);
  }
  assert.deepEqual(translated.stream_options, { include_usage: true });
});

test("translate nests flat function tools and synthesizes custom tool schemas", () => {
  const translated = translateCursorRequest(AGENT_MODE_BODY);

  assert.deepEqual(translated.tools, [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } }
      }
    },
    {
      type: "function",
      function: {
        name: "ApplyPatch",
        description: "Apply a patch",
        parameters: {
          type: "object",
          properties: { input: { type: "string" } },
          required: ["input"]
        }
      }
    }
  ]);
});

test("translate ignores non-text content parts", () => {
  const translated = translateCursorRequest({
    model: "m",
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "look at " },
          { type: "input_image", image_url: "data:image/png;base64,xxx" },
          { type: "input_text", text: "this" }
        ]
      }
    ]
  });

  assert.deepEqual(translated.messages, [{ role: "user", content: "look at this" }]);
});

test("translate accepts bare role/content items as messages", () => {
  const translated = translateCursorRequest({
    model: "m",
    input: [{ role: "user", content: "plain" }]
  });

  assert.deepEqual(translated.messages, [{ role: "user", content: "plain" }]);
});

test("translate folds consecutive function calls into one assistant turn", () => {
  const translated = translateCursorRequest({
    model: "m",
    input: [
      { type: "function_call", call_id: "c1", name: "a", arguments: "{}" },
      { type: "function_call", call_id: "c2", name: "b", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: { ok: true } },
      { type: "function_call", call_id: "c3", name: "c", arguments: "{}" }
    ]
  });

  const messages = translated.messages as Array<Record<string, unknown>>;
  assert.deepEqual(
    messages.map((message) => message.role),
    ["assistant", "tool", "assistant"]
  );
  const firstCalls = messages[0]?.tool_calls as Array<{ id: string }>;
  assert.deepEqual(firstCalls.map((call) => call.id), ["c1", "c2"]);
  // Non-string tool output is stringified, not rejected.
  assert.deepEqual(messages[1], { role: "tool", tool_call_id: "c1", content: '{"ok":true}' });
  const thirdCalls = messages[2]?.tool_calls as Array<{ id: string }>;
  assert.deepEqual(thirdCalls.map((call) => call.id), ["c3"]);
});

test("translate drops reasoning and unknown items", () => {
  const translated = translateCursorRequest({
    model: "m",
    input: [
      { type: "reasoning", encrypted_content: "blob" },
      { type: "mystery_item", payload: 1 },
      "not-an-object",
      { type: "message", role: "user", content: "hi" }
    ]
  });

  assert.deepEqual(translated.messages, [{ role: "user", content: "hi" }]);
});

test("translate maps the developer role to system", () => {
  const translated = translateCursorRequest({
    model: "m",
    input: [{ type: "message", role: "developer", content: "rules" }]
  });

  assert.deepEqual(translated.messages, [{ role: "system", content: "rules" }]);
});

test("translate turns a string input into a user message", () => {
  const translated = translateCursorRequest({ model: "m", input: "just text" });

  assert.deepEqual(translated.messages, [{ role: "user", content: "just text" }]);
});

test("translate passes a messages body through and ensures streamed usage metering", () => {
  const body = {
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    stream: true
  };

  assert.deepEqual(translateCursorRequest(body), {
    ...body,
    stream_options: { include_usage: true }
  });
});

test("translate yields empty messages when both messages and input are absent", () => {
  // Rejecting this shape is the route's job; the pure translation stays total.
  assert.deepEqual(translateCursorRequest({ model: "m" }).messages, []);
});

test("isCursorChatBody accepts messages or input and rejects other shapes", () => {
  assert.equal(isCursorChatBody({ messages: [] }), true);
  assert.equal(isCursorChatBody({ input: "hi" }), true);
  assert.equal(isCursorChatBody({ model: "m" }), false);
  assert.equal(isCursorChatBody([]), false);
  assert.equal(isCursorChatBody("nope"), false);
});

// ---- fusion gateway routes ----

function stubRunner(): FrontDoorRunner {
  return async (input) => ({
    finalOutput: `FUSION_OK:${input.prompt}`,
    runId: "run_1",
    status: "succeeded",
    evidence: []
  });
}

test("fusion gateway /v1/cursor route accepts the agent-mode body (non-streaming)", async () => {
  const gateway = await startFusionGateway({ runner: stubRunner(), defaultModel: "fusion-panel" });
  try {
    const response = await fetch(`${gateway.url()}/v1/cursor/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...AGENT_MODE_BODY, stream: false })
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      object: string;
      model: string;
      choices: Array<{ message: { content: string }; finish_reason: string }>;
    };
    assert.equal(body.object, "chat.completion");
    assert.equal(body.model, "gpt-5.5");
    assert.match(body.choices[0]?.message.content ?? "", /FUSION_OK:/);
    assert.match(body.choices[0]?.message.content ?? "", /fix the bug/);
    assert.equal(body.choices[0]?.finish_reason, "stop");
  } finally {
    await gateway.close();
  }
});

test("fusion gateway /v1/cursor route streams chat completion chunks", async () => {
  const gateway = await startFusionGateway({ runner: stubRunner(), defaultModel: "fusion-panel" });
  try {
    const response = await fetch(`${gateway.url()}/v1/cursor/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(AGENT_MODE_BODY)
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
    const text = await response.text();
    assert.match(text, /chat\.completion\.chunk/);
    assert.match(text.trimEnd(), /data: \[DONE\]$/);

    let streamed = "";
    let finishReason: string | null = null;
    for (const line of text.split("\n")) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      const chunk = JSON.parse(line.slice("data: ".length)) as {
        choices: Array<{ delta: { content?: string }; finish_reason: string | null }>;
      };
      streamed += chunk.choices[0]?.delta.content ?? "";
      if (chunk.choices[0]?.finish_reason !== null) {
        finishReason = chunk.choices[0]?.finish_reason ?? null;
      }
    }
    assert.match(streamed, /FUSION_OK:/);
    assert.equal(finishReason, "stop");
  } finally {
    await gateway.close();
  }
});

test("fusion gateway /v1/cursor route matches /v1/chat/completions for plain bodies", async () => {
  const gateway = await startFusionGateway({ runner: stubRunner(), defaultModel: "fusion-panel" });
  try {
    const body = JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] });
    const headers = { "content-type": "application/json" };
    const cursorResponse = await fetch(`${gateway.url()}/v1/cursor/chat/completions`, {
      method: "POST",
      headers,
      body
    });
    const plainResponse = await fetch(`${gateway.url()}/v1/chat/completions`, {
      method: "POST",
      headers,
      body
    });
    assert.equal(cursorResponse.status, 200);
    assert.equal(plainResponse.status, 200);
    const cursorBody = (await cursorResponse.json()) as {
      model: string;
      choices: Array<{ message: { content: string } }>;
    };
    const plainBody = (await plainResponse.json()) as {
      model: string;
      choices: Array<{ message: { content: string } }>;
    };
    assert.equal(cursorBody.model, plainBody.model);
    assert.deepEqual(
      cursorBody.choices.map((choice) => choice.message.content),
      plainBody.choices.map((choice) => choice.message.content)
    );
  } finally {
    await gateway.close();
  }
});

test("fusion gateway /v1/cursor route rejects a body without messages or input", async () => {
  const gateway = await startFusionGateway({ runner: stubRunner(), defaultModel: "fusion-panel" });
  try {
    const response = await fetch(`${gateway.url()}/v1/cursor/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5" })
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: { message: string; type: string } };
    assert.equal(body.error.type, "invalid_request_error");
    assert.match(body.error.message, /messages/);
    assert.match(body.error.message, /input/);
  } finally {
    await gateway.close();
  }
});

test("fusion gateway /v1/cursor/models mirrors /v1/models", async () => {
  const gateway = await startFusionGateway({ runner: stubRunner(), defaultModel: "fusion-panel" });
  try {
    const cursorModels = await fetch(`${gateway.url()}/v1/cursor/models`);
    const plainModels = await fetch(`${gateway.url()}/v1/models`);
    assert.deepEqual(await cursorModels.json(), await plainModels.json());
  } finally {
    await gateway.close();
  }
});

// ---- local-model gateway routes ----

function fakeBackend(): { backend: Backend; lastChatBody: () => unknown } {
  let lastBody: unknown;
  const backend: Backend = {
    defaultModel: "fake-model",
    chat: async (body) => {
      lastBody = body;
      return new Response(
        JSON.stringify({
          object: "chat.completion",
          model: (body as { model?: string }).model,
          choices: [{ index: 0, message: { role: "assistant", content: "hello from fake" }, finish_reason: "stop" }]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    },
    models: async () =>
      new Response(
        JSON.stringify({ object: "list", data: [{ id: "fake-model", object: "model" }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      ),
    embeddings: async () => new Response("{}", { status: 200 })
  };
  return { backend, lastChatBody: () => lastBody };
}

test("local gateway /v1/cursor route translates the hybrid before the backend call", async () => {
  const { backend, lastChatBody } = fakeBackend();
  const gateway = await startGateway({ backend });
  try {
    const response = await fetch(`${gateway.url()}/v1/cursor/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...AGENT_MODE_BODY, stream: false })
    });
    assert.equal(response.status, 200);
    const sent = lastChatBody() as Record<string, unknown>;
    assert.equal("input" in sent, false, "the hybrid input list must not reach the backend");
    assert.equal(Array.isArray(sent.messages), true);
    assert.equal(sent.max_tokens, 4096);
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    assert.equal(body.choices[0]?.message.content, "hello from fake");
  } finally {
    await gateway.close();
  }
});

test("local gateway /v1/cursor route rejects a body without messages or input", async () => {
  const { backend } = fakeBackend();
  const gateway = await startGateway({ backend });
  try {
    const response = await fetch(`${gateway.url()}/v1/cursor/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fake-model" })
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: { type: string } };
    assert.equal(body.error.type, "invalid_request_error");
  } finally {
    await gateway.close();
  }
});

test("local gateway /v1/cursor/models mirrors /v1/models", async () => {
  const { backend } = fakeBackend();
  const gateway = await startGateway({ backend });
  try {
    const cursorModels = await fetch(`${gateway.url()}/v1/cursor/models`);
    const plainModels = await fetch(`${gateway.url()}/v1/models`);
    assert.deepEqual(await cursorModels.json(), await plainModels.json());
  } finally {
    await gateway.close();
  }
});
