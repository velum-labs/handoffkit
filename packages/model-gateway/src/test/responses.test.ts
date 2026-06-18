import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";

import { OpenAiBackend } from "../backend.js";
import { MODEL_CALL_ID_HEADER } from "../provenance.js";
import { responsesToChat } from "../adapters/responses.js";
import { startGateway } from "../server.js";

/**
 * M3 coverage: the OpenAI Responses adapter (Codex) against a mock OpenAI
 * chat backend. Verifies request translation (instructions, input items,
 * function-call outputs, tools), the non-streaming `response` object, and the
 * streamed Responses event sequence.
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
        res.write('data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":" there"},"finish_reason":null}]}\n\n');
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      sendJson(res, 200, {
        id: "cmpl-2",
        object: "chat.completion",
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "Final answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 6, completion_tokens: 2 }
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

test("responsesToChat maps instructions, input items, and function output", () => {
  const chat = responsesToChat(
    {
      model: "gpt-x",
      instructions: "be terse",
      input: [
        { type: "message", role: "user", content: "search please" },
        { type: "function_call", call_id: "call_1", name: "search", arguments: '{"q":"x"}' },
        { type: "function_call_output", call_id: "call_1", output: "found" }
      ],
      tools: [{ type: "function", name: "search", description: "find", parameters: { type: "object" } }]
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
  assert.equal((messages[3] as { tool_call_id?: string }).tool_call_id, "call_1");
  const tools = chat.tools as Array<{ function: { name: string } }>;
  assert.equal(tools[0]?.function.name, "search");
});

test("responsesToChat coalesces parallel function calls into one assistant message", () => {
  // Codex emits parallel tool calls as separate function_call items; they must
  // become a single assistant message so the following tool messages answer it
  // (the chat API rejects an assistant tool_calls message that is not directly
  // followed by tool responses for each tool_call_id).
  const chat = responsesToChat(
    {
      input: [
        { type: "message", role: "user", content: "fix it" },
        { type: "function_call", call_id: "call_a", name: "read_file", arguments: '{"path":"a.js"}' },
        { type: "function_call", call_id: "call_b", name: "read_file", arguments: '{"path":"b.js"}' },
        { type: "function_call_output", call_id: "call_a", output: "A" },
        { type: "function_call_output", call_id: "call_b", output: "B" }
      ]
    },
    "local-model"
  );
  const messages = chat.messages as Record<string, unknown>[];
  // user, assistant(tool_calls:[a,b]), tool(a), tool(b)
  assert.equal(messages.length, 4);
  assert.equal(messages[1]?.role, "assistant");
  const toolCalls = (messages[1] as { tool_calls?: Array<{ id: string }> }).tool_calls ?? [];
  assert.equal(toolCalls.length, 2);
  assert.deepEqual(
    toolCalls.map((call) => call.id),
    ["call_a", "call_b"]
  );
  assert.equal(messages[2]?.role, "tool");
  assert.equal((messages[2] as { tool_call_id?: string }).tool_call_id, "call_a");
  assert.equal(messages[3]?.role, "tool");
  assert.equal((messages[3] as { tool_call_id?: string }).tool_call_id, "call_b");
});

test("serves a non-streaming Responses object end to end", async () => {
  const mock = await startMock();
  const gateway = await startGateway({
    backend: new OpenAiBackend({ baseUrl: `${mock.url}/v1`, defaultModel: "local-model" })
  });
  try {
    const response = await fetch(`${gateway.url()}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-x", input: "hello" })
    });
    assert.equal(response.status, 200);
    assert.equal(mock.lastModelCallId(), response.headers.get(MODEL_CALL_ID_HEADER));
    const json = (await response.json()) as {
      object: string;
      status: string;
      output: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
      usage: { input_tokens: number; output_tokens: number };
    };
    assert.equal(json.object, "response");
    assert.equal(json.status, "completed");
    assert.equal(json.output[0]?.type, "message");
    assert.equal(json.output[0]?.content?.[0]?.text, "Final answer");
    assert.equal(json.usage.output_tokens, 2);
    assert.equal(mock.lastChatBody()?.model, "local-model");
  } finally {
    await gateway.close();
    await mock.close();
  }
});

test("translates a streamed Responses event sequence", async () => {
  const mock = await startMock();
  const gateway = await startGateway({
    backend: new OpenAiBackend({ baseUrl: `${mock.url}/v1`, defaultModel: "local-model" })
  });
  try {
    const response = await fetch(`${gateway.url()}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-x", stream: true, input: "hello" })
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const text = await response.text();
    assert.ok(text.includes("event: response.created"));
    assert.ok(text.includes("event: response.output_item.added"));
    assert.ok(text.includes('event: response.output_text.delta'));
    assert.ok(text.includes('"delta":"Hi"'));
    assert.ok(text.includes("event: response.completed"));
  } finally {
    await gateway.close();
    await mock.close();
  }
});
