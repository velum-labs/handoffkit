import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";

import { OpenAiBackend } from "../backend.js";
import { MODEL_CALL_ID_HEADER } from "../provenance.js";
import {
  chatToResponses,
  customToolNames,
  openAiSseToResponses,
  responsesToChat
} from "../adapters/responses.js";
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

test("responsesToChat folds an assistant text item and its following function calls into one message", () => {
  // A model that answers with text + tool calls in a single turn comes back
  // from Codex as a message item followed by function_call items (with the
  // echoed reasoning item in between). Replaying them as two assistant
  // messages derails tool-calling models (qwen3-coder stops mid-task with a
  // text-only "Now let me check X:" turn), so they must merge back into one.
  const chat = responsesToChat(
    {
      input: [
        { type: "message", role: "user", content: "what's in this repo?" },
        { type: "message", role: "assistant", content: "Let me check the README:\n\n" },
        { type: "reasoning", summary: [{ type: "summary_text", text: "beat" }] },
        { type: "function_call", call_id: "call_1", name: "exec_command", arguments: '{"cmd":"cat README.md"}' },
        { type: "function_call_output", call_id: "call_1", output: "# FusionKit" }
      ]
    },
    "local-model"
  );
  const messages = chat.messages as Record<string, unknown>[];
  // user, assistant(content + tool_calls), tool — NOT a separate tool_calls message.
  assert.equal(messages.length, 3);
  assert.equal(messages[1]?.role, "assistant");
  assert.equal(messages[1]?.content, "Let me check the README:\n\n");
  const toolCalls = (messages[1] as { tool_calls?: Array<{ id: string }> }).tool_calls ?? [];
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0]?.id, "call_1");
  assert.equal(messages[2]?.role, "tool");
});

test("responsesToChat does not fold function calls into a non-adjacent assistant message", () => {
  // An earlier assistant answer separated from the calls by a user turn must
  // stay text-only; the calls get their own assistant message in position.
  const chat = responsesToChat(
    {
      input: [
        { type: "message", role: "user", content: "hi" },
        { type: "message", role: "assistant", content: "Done." },
        { type: "message", role: "user", content: "now run ls" },
        { type: "function_call", call_id: "call_2", name: "exec_command", arguments: '{"cmd":"ls"}' },
        { type: "function_call_output", call_id: "call_2", output: "files" }
      ]
    },
    "local-model"
  );
  const messages = chat.messages as Record<string, unknown>[];
  // user, assistant(text), user, assistant(tool_calls), tool
  assert.equal(messages.length, 5);
  assert.equal((messages[1] as { tool_calls?: unknown }).tool_calls, undefined);
  assert.equal(messages[3]?.role, "assistant");
  assert.equal(messages[3]?.content, null);
  const toolCalls = (messages[3] as { tool_calls?: Array<{ id: string }> }).tool_calls ?? [];
  assert.equal(toolCalls[0]?.id, "call_2");
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

// ---- custom (freeform) tool round-trip: Codex apply_patch ----

const PATCH = "*** Begin Patch\n*** Update File: a.md\n@@\n-old\n+new\n*** End Patch\n";

function sseStream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });
}

function chatChunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

test("responsesToChat forwards a custom tool as a function tool with an {input} schema", () => {
  const body = {
    input: "patch something",
    tools: [
      {
        type: "custom",
        name: "apply_patch",
        description: "Use this to edit files.",
        format: { type: "grammar", syntax: "lark", definition: "start: PATCH" }
      },
      { type: "function", name: "shell", parameters: { type: "object", properties: { cmd: {} } } }
    ]
  };
  assert.deepEqual([...customToolNames(body)], ["apply_patch"]);
  const chat = responsesToChat(body, "local-model");
  const tools = chat.tools as Array<{
    function: { name: string; description?: string; parameters: Record<string, unknown> };
  }>;
  assert.equal(tools.length, 2);
  const patch = tools[0]?.function;
  assert.equal(patch?.name, "apply_patch");
  const properties = patch?.parameters.properties as { input?: { type: string } };
  assert.equal(properties.input?.type, "string");
  assert.deepEqual(patch?.parameters.required, ["input"]);
  // The freeform contract and the grammar are folded into the description.
  assert.match(patch?.description ?? "", /Use this to edit files\./);
  assert.match(patch?.description ?? "", /"input" field/);
  assert.match(patch?.description ?? "", /start: PATCH/);
  // The plain function tool keeps its own schema untouched.
  assert.deepEqual(tools[1]?.function.parameters, { type: "object", properties: { cmd: {} } });
});

test("responsesToChat maps echoed custom_tool_call / custom_tool_call_output items into chat history", () => {
  const chat = responsesToChat(
    {
      input: [
        { type: "message", role: "user", content: "apply the patch" },
        { type: "custom_tool_call", call_id: "call_p", name: "apply_patch", input: PATCH },
        { type: "custom_tool_call_output", call_id: "call_p", output: "Done" }
      ]
    },
    "local-model"
  );
  const messages = chat.messages as Record<string, unknown>[];
  assert.equal(messages.length, 3);
  assert.equal(messages[1]?.role, "assistant");
  const toolCalls = (messages[1] as { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> })
    .tool_calls ?? [];
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0]?.id, "call_p");
  assert.equal(toolCalls[0]?.function.name, "apply_patch");
  assert.deepEqual(JSON.parse(toolCalls[0]?.function.arguments ?? ""), { input: PATCH });
  assert.equal(messages[2]?.role, "tool");
  assert.equal((messages[2] as { tool_call_id?: string }).tool_call_id, "call_p");
  assert.equal(messages[2]?.content, "Done");
});

test("chatToResponses emits a custom_tool_call item with raw input for a custom-declared tool", () => {
  const custom = new Set(["apply_patch"]);
  const openai = {
    id: "cmpl-3",
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            { id: "call_p", function: { name: "apply_patch", arguments: JSON.stringify({ input: PATCH }) } },
            { id: "call_s", function: { name: "shell", arguments: '{"cmd":"ls"}' } }
          ]
        }
      }
    ]
  };
  const response = chatToResponses(openai, "fusion-panel", custom);
  const output = response.output as Array<Record<string, unknown>>;
  assert.equal(output.length, 2);
  assert.equal(output[0]?.type, "custom_tool_call");
  assert.equal(output[0]?.call_id, "call_p");
  assert.equal(output[0]?.name, "apply_patch");
  assert.equal(output[0]?.input, PATCH);
  assert.equal(output[1]?.type, "function_call");
  assert.equal(output[1]?.arguments, '{"cmd":"ls"}');
});

test("chatToResponses passes non-JSON custom tool arguments through as raw input", () => {
  const openai = {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ id: "call_p", function: { name: "apply_patch", arguments: PATCH } }]
        }
      }
    ]
  };
  const response = chatToResponses(openai, "fusion-panel", new Set(["apply_patch"]));
  const output = response.output as Array<Record<string, unknown>>;
  assert.equal(output[0]?.type, "custom_tool_call");
  assert.equal(output[0]?.input, PATCH);
});

test("openAiSseToResponses streams a custom tool call as custom_tool_call events", async () => {
  const args = JSON.stringify({ input: PATCH });
  const upstream = sseStream(
    chatChunk({ tool_calls: [{ index: 0, id: "call_p", function: { name: "apply_patch", arguments: args.slice(0, 12) } }] }),
    chatChunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(12) } }] }),
    chatChunk({}, "tool_calls"),
    "data: [DONE]\n\n"
  );
  const text = await new Response(openAiSseToResponses(upstream, "fusion-panel", new Set(["apply_patch"]))).text();
  assert.ok(text.includes('"type":"custom_tool_call"'));
  assert.ok(text.includes("event: response.custom_tool_call_input.delta"));
  assert.ok(text.includes("event: response.custom_tool_call_input.done"));
  // The raw patch text (not the JSON wrapper) is what reaches the caller.
  assert.ok(text.includes(JSON.stringify(PATCH).slice(1, -1)));
  assert.ok(!text.includes("response.function_call_arguments"), "custom calls emit no function-call argument events");
  // The terminal response object carries the completed custom_tool_call item.
  const completed = text
    .split("\n\n")
    .find((event) => event.startsWith("event: response.completed"));
  assert.ok(completed !== undefined);
  const payload = JSON.parse(completed.slice(completed.indexOf("data:") + 5)) as {
    response: { output: Array<{ type: string; name?: string; input?: string }> };
  };
  const item = payload.response.output.find((entry) => entry.type === "custom_tool_call");
  assert.equal(item?.name, "apply_patch");
  assert.equal(item?.input, PATCH);
});

test("openAiSseToResponses keeps function tools on the incremental function_call path", async () => {
  const upstream = sseStream(
    chatChunk({ tool_calls: [{ index: 0, id: "call_s", function: { name: "shell", arguments: '{"cmd":"ls"}' } }] }),
    chatChunk({}, "tool_calls"),
    "data: [DONE]\n\n"
  );
  const text = await new Response(openAiSseToResponses(upstream, "fusion-panel", new Set(["apply_patch"]))).text();
  assert.ok(text.includes('"type":"function_call"'));
  assert.ok(text.includes("event: response.function_call_arguments.delta"));
  assert.ok(!text.includes("custom_tool_call"));
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
