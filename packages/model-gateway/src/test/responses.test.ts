import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";

import { OpenAiBackend } from "../backend.js";
import { MODEL_CALL_ID_HEADER } from "../provenance.js";
import { CatalogBackend } from "../router.js";
import {
  chatToResponses,
  customToolNames,
  openAiSseToResponses,
  responsesToChat,
  responsesToolRegistry
} from "../adapters/responses.js";
import { startGateway } from "../server.js";
import type { ProviderRelay } from "../server.js";

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
        { type: "function_call_output", call_id: "call_1", output: "# RouteKit" }
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

test("responsesToChat tolerates reasoning: null and text: null (Codex custom-provider slugs)", () => {
  // Regression (ENG-615): Codex serializes `reasoning: null` for any model
  // slug it cannot resolve to reasoning metadata — which includes custom
  // endpoints routed through a compatible gateway (e.g. `grok-4`, `deepseek`).
  // The adapter used to dereference it (`Cannot read properties of null
  // (reading 'effort')`), turning EVERY member request into a 502 and the
  // whole custom-endpoint response into an `exit_error`.
  const chat = responsesToChat(
    { model: "grok-4", input: "say OK", reasoning: null, text: null, stream: true },
    "grok-4"
  );
  assert.equal(chat.model, "grok-4");
  assert.equal(chat.reasoning_effort, undefined);
  assert.equal(chat.response_format, undefined);
});

test("responsesToChat still maps a real reasoning effort", () => {
  const chat = responsesToChat(
    { model: "gpt-5.5", input: "say OK", reasoning: { effort: "medium" } },
    "gpt-5.5"
  );
  assert.equal(chat.reasoning_effort, "medium");
});

test("responsesToChat treats Codex's explicit null fields as absent", () => {
  // Codex sends `"reasoning": null` (and can null other optional fields) when
  // the selected model's metadata advertises no reasoning levels — the default
  // for a custom-provider model. Reading `.effort` off
  // that null used to throw, turning every custom-provider Codex turn into a 502 (and
  // leaving the --observe dashboard empty because no turn ever ran).
  const chat = responsesToChat(
    {
      model: "route-primary",
      input: "say hi",
      reasoning: null,
      text: null,
      tool_choice: null,
      metadata: null,
      previous_response_id: null,
      include: []
    },
    "local-model"
  );
  assert.equal(chat.model, "local-model");
  assert.deepEqual(chat.messages, [{ role: "user", content: "say hi" }]);
  assert.equal(chat.reasoning_effort, undefined);
  assert.equal(chat.response_format, undefined);
  assert.equal(chat.tool_choice, undefined);
});

test("serves a Responses request carrying reasoning: null end to end", async () => {
  // The member capture gateway path: codex exec -> /v1/responses with
  // `reasoning: null` -> chat completion upstream. Must be a 200, never a 502.
  const mock = await startMock();
  const gateway = await startGateway({
    backend: new OpenAiBackend({ baseUrl: `${mock.url}/v1`, defaultModel: "grok-4" })
  });
  try {
    const response = await fetch(`${gateway.url()}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "grok-4",
        input: "say OK",
        reasoning: null,
        include: [],
        store: false,
        stream: false
      })
    });
    assert.equal(response.status, 200);
    const json = (await response.json()) as {
      status: string;
      output: Array<{ type: string; content?: Array<{ text?: string }> }>;
    };
    assert.equal(json.status, "completed");
    assert.equal(json.output[0]?.content?.[0]?.text, "Final answer");
    assert.equal(mock.lastChatBody()?.reasoning_effort, undefined);
  } finally {
    await gateway.close();
    await mock.close();
  }
});

test("serves a Responses request with null optional fields end to end", async () => {
  const mock = await startMock();
  const gateway = await startGateway({
    backend: new OpenAiBackend({ baseUrl: `${mock.url}/v1`, defaultModel: "local-model" })
  });
  try {
    const response = await fetch(`${gateway.url()}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "route-primary",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
        reasoning: null,
        text: null,
        tool_choice: "auto",
        parallel_tool_calls: false,
        store: false,
        include: []
      })
    });
    assert.equal(response.status, 200);
    const json = (await response.json()) as { object: string; status: string };
    assert.equal(json.object, "response");
    assert.equal(json.status, "completed");
  } finally {
    await gateway.close();
    await mock.close();
  }
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
  const custom = new Map([["apply_patch", { kind: "custom" as const }]]);
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
  const response = chatToResponses(openai, "route-primary", custom);
  const output = response.output as Array<Record<string, unknown>>;
  assert.equal(output.length, 2);
  assert.equal(output[0]?.type, "custom_tool_call");
  assert.equal(output[0]?.call_id, "call_p");
  assert.equal(output[0]?.name, "apply_patch");
  assert.equal(output[0]?.input, PATCH);
  assert.equal(output[1]?.type, "function_call");
  assert.equal(output[1]?.arguments, '{"cmd":"ls"}');
});

test("chatToResponses preserves provider cost metadata", () => {
  const response = chatToResponses(
    {
      id: "cmpl-cost",
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
      provider_cost: {
        source: "provider",
        cost_usd: 0.0042,
        generation_id: "gen_test"
      }
    },
    "route-primary"
  );

  assert.deepEqual(response.provider_cost, {
    source: "provider",
    cost_usd: 0.0042,
    generation_id: "gen_test"
  });
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
  const response = chatToResponses(openai, "route-primary", new Map([["apply_patch", { kind: "custom" as const }]]));
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
  const text = await new Response(openAiSseToResponses(upstream, "route-primary", new Map([["apply_patch", { kind: "custom" as const }]]))).text();
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

// Typed (nameless) tool declarations, verbatim shapes from Codex 0.142:
// `tool_search` is client-executed discovery; `web_search` is server-executed.
const TOOL_SEARCH_DECL = {
  type: "tool_search",
  execution: "client",
  description: "Searches over deferred tool metadata.",
  parameters: {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "number" } },
    required: ["query"]
  }
};
const WEB_SEARCH_DECL = { type: "web_search", external_web_access: false };

test("responsesToolRegistry classifies function, custom, and client-typed tools", () => {
  const registry = responsesToolRegistry({
    tools: [
      { type: "function", name: "shell", parameters: {} },
      { type: "custom", name: "apply_patch" },
      TOOL_SEARCH_DECL,
      WEB_SEARCH_DECL
    ]
  });
  assert.equal(registry.get("shell")?.kind, "function");
  assert.equal(registry.get("apply_patch")?.kind, "custom");
  assert.equal(registry.get("tool_search")?.kind, "typed");
  // Server-executed typed tools are not callable through the gateway.
  assert.equal(registry.has("web_search"), false);
});

test("responsesToChat projects a client-typed tool under its type and excludes server-typed tools", () => {
  const chat = responsesToChat(
    {
      input: "find tools",
      tools: [{ type: "function", name: "shell", parameters: {} }, TOOL_SEARCH_DECL, WEB_SEARCH_DECL]
    },
    "local-model"
  );
  const tools = chat.tools as Array<{ function: { name: string; description?: string; parameters: unknown } }>;
  assert.deepEqual(
    tools.map((tool) => tool.function.name),
    ["shell", "tool_search"]
  );
  assert.equal(tools[1]?.function.description, TOOL_SEARCH_DECL.description);
  assert.deepEqual(tools[1]?.function.parameters, TOOL_SEARCH_DECL.parameters);
});

test("responsesToChat resolves a typed tool_choice to the projected function name", () => {
  const chat = responsesToChat(
    { input: "x", tools: [TOOL_SEARCH_DECL], tool_choice: { type: "tool_search" } },
    "local-model"
  );
  assert.deepEqual(chat.tool_choice, { type: "function", function: { name: "tool_search" } });
});

test("responsesToChat replays echoed typed call/output items into chat history", () => {
  const args = { query: "spawn sub-agent", limit: 8 };
  const discovered = [{ type: "namespace", name: "multi_agent_v1", tools: [{ name: "spawn_agent" }] }];
  const chat = responsesToChat(
    {
      input: [
        { type: "message", role: "user", content: "spawn a sub-agent" },
        {
          type: "tool_search_call",
          call_id: "call_ts",
          status: "completed",
          execution: "client",
          arguments: args
        },
        { type: "tool_search_output", call_id: "call_ts", status: "completed", execution: "client", tools: discovered }
      ]
    },
    "local-model"
  );
  const messages = chat.messages as Record<string, unknown>[];
  assert.equal(messages.length, 3);
  const toolCalls = (messages[1] as { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> })
    .tool_calls ?? [];
  assert.equal(toolCalls[0]?.id, "call_ts");
  assert.equal(toolCalls[0]?.function.name, "tool_search");
  assert.deepEqual(JSON.parse(toolCalls[0]?.function.arguments ?? ""), args);
  assert.equal(messages[2]?.role, "tool");
  assert.equal((messages[2] as { tool_call_id?: string }).tool_call_id, "call_ts");
  const result = JSON.parse(String(messages[2]?.content)) as { tools?: unknown };
  assert.deepEqual(result.tools, discovered);
});

test("chatToResponses emits a native typed item for a call resolved as typed", () => {
  const registry = responsesToolRegistry({ tools: [TOOL_SEARCH_DECL] });
  const openai = {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ id: "call_ts", function: { name: "tool_search", arguments: '{"query":"spawn","limit":4}' } }]
        }
      }
    ]
  };
  const response = chatToResponses(openai, "route-primary", registry);
  const output = response.output as Array<Record<string, unknown>>;
  assert.equal(output.length, 1);
  assert.equal(output[0]?.type, "tool_search_call");
  assert.equal(output[0]?.call_id, "call_ts");
  assert.equal(output[0]?.execution, "client");
  assert.equal(output[0]?.status, "completed");
  // Native typed items carry arguments as a JSON value, not a string.
  assert.deepEqual(output[0]?.arguments, { query: "spawn", limit: 4 });
});

test("openAiSseToResponses streams a typed tool call as its native item", async () => {
  const registry = responsesToolRegistry({ tools: [TOOL_SEARCH_DECL] });
  const args = '{"query":"spawn sub-agent","limit":8}';
  const upstream = sseStream(
    chatChunk({ tool_calls: [{ index: 0, id: "call_ts", function: { name: "tool_search", arguments: args.slice(0, 10) } }] }),
    chatChunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(10) } }] }),
    chatChunk({}, "tool_calls"),
    "data: [DONE]\n\n"
  );
  const text = await new Response(openAiSseToResponses(upstream, "route-primary", registry)).text();
  assert.ok(text.includes('"type":"tool_search_call"'));
  assert.ok(!text.includes('"type":"function_call"'), "typed calls never surface as function_call items");
  assert.ok(!text.includes("response.function_call_arguments"), "typed calls emit no argument delta events");
  const completed = text.split("\n\n").find((event) => event.startsWith("event: response.completed"));
  assert.ok(completed !== undefined);
  const payload = JSON.parse(completed.slice(completed.indexOf("data:") + 5)) as {
    response: { output: Array<{ type: string; call_id?: string; arguments?: unknown; execution?: string }> };
  };
  const item = payload.response.output.find((entry) => entry.type === "tool_search_call");
  assert.equal(item?.call_id, "call_ts");
  assert.equal(item?.execution, "client");
  assert.deepEqual(item?.arguments, { query: "spawn sub-agent", limit: 8 });
});

test("openAiSseToResponses keeps function tools on the incremental function_call path", async () => {
  const upstream = sseStream(
    chatChunk({ tool_calls: [{ index: 0, id: "call_s", function: { name: "shell", arguments: '{"cmd":"ls"}' } }] }),
    chatChunk({}, "tool_calls"),
    "data: [DONE]\n\n"
  );
  const text = await new Response(openAiSseToResponses(upstream, "route-primary", new Map([["apply_patch", { kind: "custom" as const }]]))).text();
  assert.ok(text.includes('"type":"function_call"'));
  assert.ok(text.includes("event: response.function_call_arguments.delta"));
  assert.ok(!text.includes("custom_tool_call"));
});

test("a mid-stream provider error event becomes response.failed with the upstream message", async () => {
  // The router surfaces a classified provider failure as an OpenAI-style
  // `data: {"error": {...}}` SSE event. The Responses translation must carry
  // that message to the consumer (codex shows it verbatim) instead of ending
  // the stream as a bare disconnect.
  const stream = openAiSseToResponses(
    sseStream(
      `data: ${JSON.stringify({
        error: {
          message: "openrouter call failed (unknown); see the server logs for the provider's message",
          type: "provider_error",
          code: "unknown"
        }
      })}\n\n`,
      "data: [DONE]\n\n"
    ),
    "grok-4"
  );
  const text = await new Response(stream).text();
  assert.ok(text.includes("event: response.failed"));
  assert.ok(text.includes("openrouter call failed (unknown)"));
  assert.ok(!text.includes("event: response.completed"));
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

test("Codex picker aliases use the canonical catalog and pooled native relay", async () => {
  const sourceCalls: string[] = [];
  const source = (sourceId: "codex" | "claude-code") => ({
    sourceId,
    discoverModels: async () => [
      {
        id:
          sourceId === "codex"
            ? "gpt-5.5"
            : "claude-sonnet-4-6"
      }
    ],
    chat: async (body: unknown) => {
      sourceCalls.push((body as { model: string }).model);
      return Response.json({
        id: "chatcmpl_cross_provider",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "CROSS_PROVIDER_OK" },
            finish_reason: "stop"
          }
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      });
    },
    embeddings: async () => Response.json({})
  });
  const backend = await CatalogBackend.create({
    config: {
      providers: { codex: {}, "claude-code": {} },
      defaultModel: "codex/gpt-5.5"
    },
    sources: {
      codex: source("codex"),
      "claude-code": source("claude-code")
    }
  });
  const relayedBodies: Array<Record<string, unknown>> = [];
  const relay: ProviderRelay = {
    dialect: "codex",
    shouldRelay: () => false,
    relay: async (_headers, body) => {
      relayedBodies.push(body as Record<string, unknown>);
      return Response.json({
        id: "resp_native",
        object: "response",
        status: "completed",
        model: (body as { model: string }).model,
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    },
    mergedCatalog: async () => ({
      models: [
        {
          slug: "gpt-5.5",
          display_name: "GPT-5.5",
          description: "Native Codex model",
          visibility: "list",
          priority: 7
        }
      ],
      etag: 'W/"upstream-catalog"'
    })
  };
  const gateway = await startGateway({
    backend,
    providerRelays: { codex: relay }
  });
  try {
    const catalogResponse = await fetch(
      `${gateway.url()}/v1/models?client_version=1.0.0`
    );
    assert.equal(
      catalogResponse.headers.get("etag"),
      null,
      "a projected managed catalog must not reuse the upstream ETag"
    );
    const catalog = (await catalogResponse.json()) as {
      data: Array<{ id: string }>;
      models: Array<{ slug: string; display_name: string }>;
    };
    assert.deepEqual(
      catalog.data.map((model) => model.id),
      ["codex/gpt-5.5", "claude-code/claude-sonnet-4-6"]
    );
    assert.deepEqual(
      catalog.models.map(({ slug, display_name }) => [slug, display_name]),
      [
        ["gpt-5.5", "GPT-5.5"],
        [
          "claude-code/claude-sonnet-4-6",
          "claude-code/claude-sonnet-4-6"
        ]
      ]
    );

    for (const model of ["gpt-5.5", "codex/gpt-5.5"]) {
      const response = await fetch(`${gateway.url()}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          input: "hi",
          store: false,
          reasoning: { effort: "high" }
        })
      });
      assert.equal(response.status, 200);
      assert.equal(
        ((await response.json()) as { model: string }).model,
        "gpt-5.5"
      );
    }
    assert.deepEqual(
      relayedBodies.map((body) => body.model),
      ["gpt-5.5", "gpt-5.5"]
    );
    assert.ok(relayedBodies.every((body) => body.store === false));
    assert.ok(
      relayedBodies.every(
        (body) =>
          (body.reasoning as { effort?: string } | undefined)?.effort ===
          "high"
      )
    );
    assert.deepEqual(sourceCalls, []);

    const unknown = await fetch(`${gateway.url()}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-not-real", input: "hi" })
    });
    assert.equal(unknown.status, 400);
    assert.match(await unknown.text(), /unknown model/);
    assert.deepEqual(
      relayedBodies.map((body) => body.model),
      ["gpt-5.5", "gpt-5.5"]
    );
  } finally {
    await gateway.close();
  }
});
