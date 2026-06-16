import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";

import { anthropicToChat, chatToAnthropicMessage, mapStopReason } from "../adapters/anthropic.js";
import { OpenAiBackend } from "../backend.js";
import { MODEL_CALL_ID_HEADER } from "../provenance.js";
import { startGateway } from "../server.js";

/**
 * M2 coverage: the Anthropic Messages adapter against a mock OpenAI backend.
 * Verifies request translation (system, tools, tool results), non-streaming
 * and streaming response shapes, count_tokens, and discovery.
 */

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
