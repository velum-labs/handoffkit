import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";

import {
  anthropicModelsResponse,
  anthropicToChat,
  chatToAnthropicMessage,
  claudeModelAlias,
  mapStopReason,
  openAiSseToAnthropic
} from "../adapters/anthropic.js";
import { OpenAiBackend } from "../backend.js";
import { MODEL_CALL_ID_HEADER } from "../provenance.js";
import { startGateway } from "../server.js";

/**
 * M2 coverage: the Anthropic Messages adapter against a mock OpenAI backend.
 * Verifies request translation (system, tools, tool results), non-streaming
 * and streaming response shapes, count_tokens, and discovery.
 */

test("anthropicModelsResponse aliases every model past Claude Code's claude/anthropic filter", async () => {
  const res = anthropicModelsResponse("fusion-panel", [
    "fusion-panel",
    "claude-opus-4-8",
    "gpt-5.5",
    "mlx-community/Qwen3-1.7B-4bit"
  ]);
  const body = (await res.json()) as { data: Array<{ id: string; display_name: string }> };
  // Every id begins with claude/anthropic so Claude Code lists them all...
  assert.ok(body.data.every((model) => model.id.startsWith("claude") || model.id.startsWith("anthropic")));
  // ...non-Anthropic ids are aliased, Anthropic-family ids pass through as-is.
  assert.deepEqual(body.data.map((model) => model.id), [
    "claude-fusion-panel",
    "claude-opus-4-8",
    "claude-gpt-5.5",
    "claude-mlx-community/Qwen3-1.7B-4bit"
  ]);
  // The picker shows the real id via display_name.
  const gpt = body.data.find((model) => model.id === "claude-gpt-5.5");
  assert.equal(gpt?.display_name, "gpt-5.5");
  assert.equal(claudeModelAlias("claude-opus-4-8"), "claude-opus-4-8");
});

test("anthropicToChat tolerates thinking: null (same failure class as Responses reasoning: null)", () => {
  const chat = anthropicToChat(
    { model: "claude-x", messages: [{ role: "user", content: "hi" }], thinking: null },
    "claude-x"
  );
  assert.equal(chat.reasoning_effort, undefined);
});

type Mock = {
  url: string;
  lastChatBody: () => Record<string, unknown> | undefined;
  lastModelCallId: () => string | undefined;
  close: () => Promise<void>;
};

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(Buffer.from(JSON.stringify(value), "utf8"));
}

async function readAll(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function startMock(): Promise<Mock> {
  let lastChatBody: Record<string, unknown> | undefined;
  let lastModelCallId: string | undefined;
  const server = createServer((req, res) => {
    void (async () => {
      const body = JSON.parse((await readAll(req)).toString("utf8")) as Record<string, unknown>;
      lastChatBody = body;
      lastModelCallId =
        typeof req.headers[MODEL_CALL_ID_HEADER] === "string"
          ? req.headers[MODEL_CALL_ID_HEADER]
          : undefined;
      if (body.stream === true) {
        res.statusCode = 200;
        res.setHeader("content-type", "text/event-stream");
        res.write('data: {"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}\n\n');
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"completion_tokens":2}}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      sendJson(res, 200, {
        id: "cmpl-1",
        object: "chat.completion",
        model: body.model,
        choices: [
          { index: 0, message: { role: "assistant", content: "Hello there" }, finish_reason: "stop" }
        ],
        usage: { prompt_tokens: 7, completion_tokens: 3 }
      });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    lastChatBody: () => lastChatBody,
    lastModelCallId: () => lastModelCallId,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
  };
}

test("anthropicToChat maps system, tools, and tool results", () => {
  const chat = anthropicToChat(
    {
      model: "claude-x",
      system: "be terse",
      max_tokens: 100,
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_1", name: "search", input: { q: "x" } }]
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_1", content: "result text" }]
        }
      ],
      tools: [{ name: "search", description: "find", input_schema: { type: "object" } }]
    },
    "local-model"
  );

  const messages = chat.messages as Record<string, unknown>[];
  assert.equal(chat.model, "local-model");
  assert.equal(messages[0]?.role, "system");
  assert.equal(messages[1]?.role, "user");
  assert.equal(messages[2]?.role, "assistant");
  assert.ok(Array.isArray((messages[2] as { tool_calls?: unknown[] }).tool_calls));
  assert.equal(messages[3]?.role, "tool");
  assert.equal((messages[3] as { tool_call_id?: string }).tool_call_id, "tu_1");
  const tools = chat.tools as Array<{ type: string; function: { name: string } }>;
  assert.equal(tools[0]?.function.name, "search");
});

test("anthropicToChat projects typed client tools but excludes server-executed tools", () => {
  const chat = anthropicToChat(
    {
      model: "claude-x",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        // Plain client tool (Claude Code's sub-agent door) — always projected.
        { name: "Task", description: "spawn a sub-agent", input_schema: { type: "object" } },
        // Anthropic-defined *client* tool: caller executes it via tool_use.
        { type: "bash_20250124", name: "bash" },
        // Server-executed tools: nothing behind the gateway can run them.
        { type: "web_search_20250305", name: "web_search", max_uses: 5 } as never,
        { type: "code_execution_20250522", name: "code_execution" }
      ]
    },
    "local-model"
  );
  const tools = chat.tools as Array<{ function: { name: string } }>;
  assert.deepEqual(
    tools.map((tool) => tool.function.name),
    ["Task", "bash"]
  );
});

test("anthropicToChat groups parallel tool_use into one assistant message", () => {
  // Anthropic batches parallel tool calls as multiple tool_use blocks in a
  // single assistant message; they must stay one assistant message followed by
  // the tool results so the chat API's tool_calls pairing stays valid.
  const chat = anthropicToChat(
    {
      messages: [
        { role: "user", content: "do both" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu_a", name: "read_file", input: { path: "a" } },
            { type: "tool_use", id: "tu_b", name: "read_file", input: { path: "b" } }
          ]
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_a", content: "A" },
            { type: "tool_result", tool_use_id: "tu_b", content: "B" }
          ]
        }
      ]
    },
    "local-model"
  );
  const messages = chat.messages as Record<string, unknown>[];
  const assistant = messages.find((m) => m.role === "assistant") as { tool_calls?: Array<{ id: string }> };
  assert.equal(assistant.tool_calls?.length, 2);
  assert.deepEqual(
    assistant.tool_calls?.map((call) => call.id),
    ["tu_a", "tu_b"]
  );
  const toolMessages = messages.filter((m) => m.role === "tool") as Array<{ tool_call_id: string }>;
  assert.deepEqual(
    toolMessages.map((m) => m.tool_call_id),
    ["tu_a", "tu_b"]
  );
});

test("anthropic streaming starts eagerly and pings during the panel phase", async () => {
  // A never-ending upstream simulates the silent fusion panel phase before the
  // judge's first token.
  let upstreamController!: ReadableStreamDefaultController<Uint8Array>;
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      upstreamController = controller;
    }
  });
  const decoder = new TextDecoder();
  const reader = openAiSseToAnthropic(upstream, "claude-x").getReader();
  try {
    // message_start must arrive before any upstream data is produced.
    const first = await reader.read();
    assert.ok(first.value !== undefined);
    assert.ok(decoder.decode(first.value).includes("event: message_start"));

    // A ping keepalive must arrive while the upstream is still silent.
    let sawPing = false;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value !== undefined && decoder.decode(value).includes("event: ping")) {
        sawPing = true;
        break;
      }
    }
    assert.ok(sawPing, "a ping keepalive must be emitted while the upstream is silent");
  } finally {
    await reader.cancel();
    // cancel() already propagates to the upstream; closing again is a no-op.
    try {
      upstreamController.close();
    } catch {
      // already closed via cancel
    }
  }
});

test("streams a fused tool call end to end as Anthropic tool_use blocks", async () => {
  // OpenAI-chat SSE with a tool call whose arguments arrive fragmented across
  // chunks, then a tool_calls finish. The adapter must reconstruct one tool_use
  // block with the fully-merged JSON input.
  const chunks = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"search","arguments":"{\\"q\\":"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"cats\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    "data: [DONE]\n\n"
  ];
  const encoder = new TextEncoder();
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });
  const decoder = new TextDecoder();
  const reader = openAiSseToAnthropic(upstream, "claude-x").getReader();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value !== undefined) out += decoder.decode(value);
  }
  assert.ok(out.includes('"type":"tool_use"'), "a tool_use content block must be emitted");
  assert.ok(out.includes('"name":"search"'), "the tool name must be carried through");
  assert.ok(out.includes("input_json_delta"), "the arguments must stream as input_json_delta");
  // Both fragments ("{\"q\": and \"cats\"}) must reach the client.
  assert.ok(out.includes("cats"), "both argument fragments must be forwarded");
  assert.ok(out.includes('"stop_reason":"tool_use"'), "tool_calls maps to a tool_use stop reason");
});

test("truncated stream (no finish_reason) surfaces an Anthropic error, not end_turn", async () => {
  // Upstream ends after some content but never sends a finish_reason / [DONE].
  const encoder = new TextEncoder();
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
      );
      controller.close();
    }
  });
  const decoder = new TextDecoder();
  const reader = openAiSseToAnthropic(upstream, "claude-x").getReader();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value !== undefined) out += decoder.decode(value);
  }
  assert.ok(out.includes("event: error"), "a truncated stream must emit an error event");
  assert.ok(!out.includes('"stop_reason":"end_turn"'), "truncation must not fabricate a clean end_turn");
});

test("chatToAnthropicMessage produces a text content block", () => {
  const message = chatToAnthropicMessage(
    {
      id: "cmpl-9",
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 1 }
    },
    "claude-x"
  );
  assert.equal(message.type, "message");
  const content = message.content as Array<{ type: string; text?: string }>;
  assert.equal(content[0]?.type, "text");
  assert.equal(content[0]?.text, "hi");
  assert.equal(message.stop_reason, "end_turn");
});

test("mapStopReason maps tool_calls to tool_use", () => {
  assert.equal(mapStopReason("tool_calls"), "tool_use");
  assert.equal(mapStopReason("length"), "max_tokens");
  assert.equal(mapStopReason("stop"), "end_turn");
});

test("serves a non-streaming Anthropic message end to end", async () => {
  const mock = await startMock();
  const gateway = await startGateway({
    backend: new OpenAiBackend({ baseUrl: `${mock.url}/v1`, defaultModel: "local-model" })
  });
  try {
    const response = await fetch(`${gateway.url()}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-x", max_tokens: 50, messages: [{ role: "user", content: "hi" }] })
    });
    assert.equal(response.status, 200);
    assert.equal(mock.lastModelCallId(), response.headers.get(MODEL_CALL_ID_HEADER));
    const json = (await response.json()) as { type: string; content: Array<{ type: string; text?: string }>; model: string };
    assert.equal(json.type, "message");
    assert.equal(json.model, "claude-x");
    assert.equal(json.content[0]?.text, "Hello there");
    // Upstream got the backend model, not the claude id.
    assert.equal(mock.lastChatBody()?.model, "local-model");
  } finally {
    await gateway.close();
    await mock.close();
  }
});

test("translates a streamed Anthropic message", async () => {
  const mock = await startMock();
  const gateway = await startGateway({
    backend: new OpenAiBackend({ baseUrl: `${mock.url}/v1`, defaultModel: "local-model" })
  });
  try {
    const response = await fetch(`${gateway.url()}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-x", max_tokens: 50, stream: true, messages: [{ role: "user", content: "hi" }] })
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const text = await response.text();
    assert.ok(text.includes("event: message_start"));
    assert.ok(text.includes("event: content_block_start"));
    assert.ok(text.includes('"type":"text_delta","text":"Hel"'));
    assert.ok(text.includes("event: message_stop"));
  } finally {
    await gateway.close();
    await mock.close();
  }
});

test("estimates tokens and serves Anthropic discovery", async () => {
  const mock = await startMock();
  const gateway = await startGateway({
    backend: new OpenAiBackend({ baseUrl: `${mock.url}/v1`, defaultModel: "local-model" })
  });
  try {
    const count = await fetch(`${gateway.url()}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-x", messages: [{ role: "user", content: "hello world" }] })
    });
    assert.equal(count.status, 200);
    const counted = (await count.json()) as { input_tokens: number };
    assert.ok(counted.input_tokens > 0);

    const models = await fetch(`${gateway.url()}/v1/models`, {
      headers: { "anthropic-version": "2023-06-01" }
    });
    const list = (await models.json()) as { data: Array<{ id: string }> };
    assert.ok(list.data[0]?.id.startsWith("claude"));
  } finally {
    await gateway.close();
    await mock.close();
  }
});
