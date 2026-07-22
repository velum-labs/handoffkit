import assert from "node:assert/strict";
import { test } from "node:test";

import {
  chatToResponses,
  responsesToChat,
  responsesToolRegistry
} from "../adapters/responses.js";
import { anthropicToChat, chatToAnthropicMessage, openAiSseToAnthropic } from "../adapters/anthropic.js";
import type { AnthropicRequest } from "../adapters/anthropic.js";
import { openAiSseToResponses } from "../adapters/responses-stream.js";
import {
  composeServerToolStream,
  runBufferedServerToolLoop
} from "../adapters/server-tool-loop.js";
import {
  ANTHROPIC_MESSAGE_CONTENT,
  type AnthropicNativeContentBlock
} from "../adapters/openai-chat-wire.js";
import { resolveWebSearchExecutor } from "../adapters/web-search.js";
import type { WebSearchExecutor, WebSearchOutcome } from "../adapters/web-search.js";

/**
 * Server-tool loop coverage (gateway-executed web search): executor selection,
 * ingress projection/replay in both dialects, the buffered and streaming inner
 * loops, and the native item rendering in both egress translators.
 */

// Verbatim shape from Codex 0.142: a nameless server-executed typed tool.
const WEB_SEARCH_DECL = { type: "web_search" };

function fakeExecutor(results: Record<string, WebSearchOutcome>): WebSearchExecutor & { queries: string[] } {
  const queries: string[] = [];
  return {
    provider: "openai",
    model: "fake-search",
    queries,
    async search(query) {
      queries.push(query);
      const outcome = results[query];
      if (outcome === undefined) throw new Error(`no fake result for query: ${query}`);
      return outcome;
    }
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function chatCompletion(message: Record<string, unknown>, finishReason = "stop"): Record<string, unknown> {
  return {
    id: "cmpl-x",
    choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 5 }
  };
}

function sseStream(...events: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(new TextEncoder().encode(event));
      controller.close();
    }
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null, extra: Record<string, unknown> = {}): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }], ...extra })}\n\n`;
}

// ---- executor selection ----

test("resolveWebSearchExecutor prefers the dialect's own provider and falls back", () => {
  const both = { OPENAI_API_KEY: "sk-a", ANTHROPIC_API_KEY: "sk-b" };
  assert.equal(resolveWebSearchExecutor("responses", both)?.provider, "openai");
  assert.equal(resolveWebSearchExecutor("anthropic", both)?.provider, "anthropic");
  assert.equal(resolveWebSearchExecutor("anthropic", { OPENAI_API_KEY: "sk-a" })?.provider, "openai");
  assert.equal(resolveWebSearchExecutor("responses", { ANTHROPIC_API_KEY: "sk-b" })?.provider, "anthropic");
  assert.equal(resolveWebSearchExecutor("responses", {}), undefined);
  assert.equal(resolveWebSearchExecutor("responses", { ...both, ROUTEKIT_WEB_SEARCH: "0" }), undefined);
});

// ---- Responses ingress ----

test("responsesToolRegistry registers web_search as a server tool only when enabled", () => {
  const body = { tools: [WEB_SEARCH_DECL] };
  assert.equal(responsesToolRegistry(body).has("web_search"), false);
  assert.equal(responsesToolRegistry(body, { serverTools: true }).get("web_search")?.kind, "server");
});

test("responsesToChat projects web_search as a function tool when enabled", () => {
  const chat = responsesToChat({ input: "x", tools: [WEB_SEARCH_DECL] }, "local-model", { serverTools: true });
  const tools = chat.tools as Array<{ function: { name: string; parameters: { required?: string[] } } }>;
  assert.deepEqual(tools.map((tool) => tool.function.name), ["web_search"]);
  assert.deepEqual(tools[0]?.function.parameters.required, ["query"]);
  // Disabled: dropped as before (no tools at all).
  const dropped = responsesToChat({ input: "x", tools: [WEB_SEARCH_DECL] }, "local-model");
  assert.equal(dropped.tools, undefined);
});

test("responsesToChat folds an echoed id-less web_search_call into assistant context", () => {
  // Verbatim echo shape from Codex 0.142: no id, no call_id, no results.
  const chat = responsesToChat(
    {
      input: [
        { type: "message", role: "user", content: "what is new?" },
        { type: "web_search_call", status: "completed", action: { type: "search", query: "latest node lts" } },
        { type: "message", role: "assistant", content: "Node 24 is the LTS." },
        { type: "message", role: "user", content: "since when?" }
      ]
    },
    "local-model"
  );
  const messages = chat.messages as Array<{ role: string; content: unknown }>;
  assert.equal(messages.length, 4);
  assert.equal(messages[1]?.role, "assistant");
  assert.match(String(messages[1]?.content), /searched the web for: "latest node lts"/);
});

// ---- buffered loop ----

test("runBufferedServerToolLoop executes searches and loops to the final answer", async () => {
  const steps = [
    chatCompletion(
      { content: null, tool_calls: [{ id: "call_1", function: { name: "web_search", arguments: '{"query":"node lts"}' } }] },
      "tool_calls"
    ),
    chatCompletion({ content: "Node 24 is the LTS." })
  ];
  let stepIndex = 0;
  const chat: Record<string, unknown> = { model: "m", messages: [{ role: "user", content: "what is the LTS?" }] };
  const executor = fakeExecutor({ "node lts": { text: "Node.js 24 is the active LTS.", citations: [{ url: "https://nodejs.org", title: "Node.js" }] } });
  const firstStep = jsonResponse(steps[stepIndex++]);
  const outcome = await runBufferedServerToolLoop({
    chat,
    firstStep,
    runStep: async () => jsonResponse(steps[stepIndex++]),
    serverToolNames: new Set(["web_search"]),
    executor
  });
  assert.equal(outcome.kind, "openai");
  if (outcome.kind !== "openai") return;
  assert.deepEqual(executor.queries, ["node lts"]);
  assert.equal(outcome.searches.length, 1);
  assert.equal(outcome.searches[0]?.status, "completed");
  // The transcript got the assistant tool call + tool result appended.
  const messages = chat.messages as Array<{ role: string; content?: unknown; tool_call_id?: string }>;
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "tool"]);
  assert.match(String(messages[2]?.content), /Node\.js 24 is the active LTS/);
  assert.match(String(messages[2]?.content), /https:\/\/nodejs\.org/);
  // The final Responses payload renders the native item before the message.
  const rendered = chatToResponses(
    outcome.openai as never,
    "route-primary",
    responsesToolRegistry({ tools: [WEB_SEARCH_DECL] }, { serverTools: true }),
    outcome.searches
  );
  const output = rendered.output as Array<Record<string, unknown>>;
  assert.equal(output[0]?.type, "web_search_call");
  assert.equal((output[0]?.action as { query?: string }).query, "node lts");
  assert.equal(output[1]?.type, "message");
});

test("runBufferedServerToolLoop replays signed Anthropic thinking before a server tool continuation", async () => {
  const first = chatCompletion(
    {
      content: null,
      reasoning: "I should search.",
      reasoning_details: [
        {
          type: "thinking",
          index: 0,
          thinking: "I should search.",
          signature: "sig-native"
        }
      ],
      tool_calls: [
        {
          id: "call_1",
          function: { name: "web_search", arguments: '{"query":"routekit"}' }
        }
      ]
    },
    "tool_calls"
  );
  const chat: Record<string, unknown> = {
    model: "m",
    messages: [{ role: "user", content: "look it up" }]
  };
  let replayed: AnthropicNativeContentBlock[] | undefined;
  const outcome = await runBufferedServerToolLoop({
    chat,
    firstStep: jsonResponse(first),
    runStep: async (next) => {
      const assistant = (next.messages as Array<Record<string, unknown>>)[1] as
        | (Record<string, unknown> & {
            [ANTHROPIC_MESSAGE_CONTENT]?: AnthropicNativeContentBlock[];
          })
        | undefined;
      replayed = assistant?.[ANTHROPIC_MESSAGE_CONTENT];
      return jsonResponse(chatCompletion({ content: "done" }));
    },
    serverToolNames: new Set(["web_search"]),
    executor: fakeExecutor({
      routekit: { text: "RouteKit result", citations: [] }
    })
  });
  assert.equal(outcome.kind, "openai");
  assert.deepEqual(replayed?.map((block) => block.type), ["thinking", "tool_use"]);
  assert.equal(
    (replayed?.[0] as { signature?: string } | undefined)?.signature,
    "sig-native"
  );
  if (outcome.kind !== "openai") return;
  const rendered = chatToAnthropicMessage(
    outcome.openai as never,
    "route-primary",
    outcome.searches,
    outcome.events
  );
  assert.deepEqual(
    (rendered.content as Array<Record<string, unknown>>).map((block) => block.type),
    ["thinking", "server_tool_use", "web_search_tool_result", "text"]
  );
  assert.equal(
    (rendered.content as Array<Record<string, unknown>>)[0]?.signature,
    "sig-native"
  );
});

test("runBufferedServerToolLoop surfaces mixed batches and drops the server calls", async () => {
  const step = chatCompletion(
    {
      content: null,
      tool_calls: [
        { id: "call_ws", function: { name: "web_search", arguments: '{"query":"x"}' } },
        { id: "call_sh", function: { name: "shell", arguments: '{"cmd":"ls"}' } }
      ]
    },
    "tool_calls"
  );
  const executor = fakeExecutor({});
  const outcome = await runBufferedServerToolLoop({
    chat: { model: "m", messages: [] },
    firstStep: jsonResponse(step),
    runStep: async () => {
      throw new Error("must not run a second step");
    },
    serverToolNames: new Set(["web_search"]),
    executor
  });
  assert.equal(outcome.kind, "openai");
  if (outcome.kind !== "openai") return;
  assert.equal(executor.queries.length, 0);
  const message = (outcome.openai.choices as Array<{ message: { tool_calls: Array<{ id: string }> } }>)[0]?.message;
  assert.deepEqual(message?.tool_calls.map((call) => call.id), ["call_sh"]);
});

test("a failed search becomes an error tool result, not a failed turn", async () => {
  const steps = [
    chatCompletion(
      { content: null, tool_calls: [{ id: "call_1", function: { name: "web_search", arguments: '{"query":"broken"}' } }] },
      "tool_calls"
    ),
    chatCompletion({ content: "Could not verify; answering from training data." })
  ];
  let stepIndex = 0;
  const chat: Record<string, unknown> = { model: "m", messages: [] };
  const outcome = await runBufferedServerToolLoop({
    chat,
    firstStep: jsonResponse(steps[stepIndex++]),
    runStep: async () => jsonResponse(steps[stepIndex++]),
    serverToolNames: new Set(["web_search"]),
    executor: fakeExecutor({})
  });
  assert.equal(outcome.kind, "openai");
  if (outcome.kind !== "openai") return;
  assert.equal(outcome.searches[0]?.status, "failed");
  const messages = chat.messages as Array<{ role: string; content?: unknown }>;
  assert.match(String(messages[messages.length - 1]?.content), /web_search_error/);
});

test("the per-turn search cap yields limit tool results instead of executions", async () => {
  const searchStep = (): Record<string, unknown> =>
    chatCompletion(
      { content: null, tool_calls: [{ id: "c", function: { name: "web_search", arguments: '{"query":"q"}' } }] },
      "tool_calls"
    );
  const finalStep = chatCompletion({ content: "done" });
  let calls = 0;
  const chat: Record<string, unknown> = { model: "m", messages: [] };
  const executor = fakeExecutor({ q: { text: "r", citations: [] } });
  const outcome = await runBufferedServerToolLoop({
    chat,
    firstStep: jsonResponse(searchStep()),
    runStep: async () => jsonResponse(calls++ === 0 ? searchStep() : finalStep),
    serverToolNames: new Set(["web_search"]),
    executor,
    maxSearches: 1
  });
  assert.equal(outcome.kind, "openai");
  if (outcome.kind !== "openai") return;
  assert.equal(executor.queries.length, 1);
  const messages = chat.messages as Array<{ role: string; content?: unknown }>;
  assert.ok(messages.some((message) => String(message.content).includes("web_search_limit")));
});

// ---- streaming loop + Responses egress ----

test("composeServerToolStream renders native web_search_call items and one completed response", async () => {
  const firstStep = sseStream(
    chunk({ content: "Let me check. " }),
    chunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "web_search", arguments: '{"query":"node lts"}' } }] }),
    chunk({}, "tool_calls", { usage: { prompt_tokens: 10, completion_tokens: 4 } }),
    "data: [DONE]\n\n"
  );
  const secondStep = sseStream(
    chunk({ content: "Node 24 is the LTS." }),
    chunk({}, "stop", { usage: { prompt_tokens: 20, completion_tokens: 6 } }),
    "data: [DONE]\n\n"
  );
  const stepQueue = [secondStep];
  const chat: Record<string, unknown> = { model: "m", messages: [], stream: true };
  const executor = fakeExecutor({ "node lts": { text: "Node.js 24 is LTS.", citations: [{ url: "https://nodejs.org" }] } });
  const composed = composeServerToolStream({
    chat,
    firstStep,
    runStep: async () => {
      const next = stepQueue.shift();
      if (next === undefined) throw new Error("no more steps");
      return next;
    },
    serverToolNames: new Set(["web_search"]),
    executor
  });
  const registry = responsesToolRegistry({ tools: [WEB_SEARCH_DECL] }, { serverTools: true });
  const text = await new Response(openAiSseToResponses(composed, "route-primary", registry)).text();
  assert.ok(text.includes('"type":"web_search_call"'), "native search item emitted");
  assert.ok(text.includes("response.web_search_call.searching"), "search lifecycle events emitted");
  assert.ok(!text.includes('"type":"function_call"'), "the server tool never surfaces as a function_call");
  assert.equal(text.split("event: response.completed").length, 2, "exactly one terminal response.completed");
  const completedEvent = text.split("\n\n").find((event) => event.startsWith("event: response.completed"));
  assert.ok(completedEvent !== undefined);
  const payload = JSON.parse(completedEvent.slice(completedEvent.indexOf("data:") + 5)) as {
    response: { output: Array<{ type: string }>; usage: { input_tokens: number; output_tokens: number } };
  };
  assert.deepEqual(
    payload.response.output.map((item) => item.type).sort(),
    ["message", "web_search_call"]
  );
  // Usage sums both model steps.
  assert.equal(payload.response.usage.input_tokens, 30);
  assert.equal(payload.response.usage.output_tokens, 10);
  // The full text of both steps reached the message item.
  assert.ok(text.includes("Let me check."));
  assert.ok(text.includes("Node 24 is the LTS."));
});

test("composeServerToolStream carries streamed signed thinking into the continuation request", async () => {
  const firstStep = sseStream(
    chunk({
      reasoning_details: [
        { type: "thinking", index: 0, phase: "start", signature: "" }
      ]
    }),
    chunk({
      reasoning: "search first",
      reasoning_details: [
        {
          type: "thinking",
          index: 0,
          phase: "delta",
          thinking: "search first"
        }
      ]
    }),
    chunk({
      reasoning_details: [
        {
          type: "thinking",
          index: 0,
          phase: "signature",
          signature: "sig-stream-loop"
        }
      ]
    }),
    chunk({
      reasoning_details: [
        { type: "thinking", index: 0, phase: "stop" }
      ]
    }),
    chunk({
      tool_calls: [
        {
          index: 0,
          id: "call_1",
          function: {
            name: "web_search",
            arguments: '{"query":"routekit"}'
          }
        }
      ]
    }),
    chunk({}, "tool_calls"),
    "data: [DONE]\n\n"
  );
  const secondStep = sseStream(
    chunk({
      reasoning_details: [
        { type: "thinking", index: 0, phase: "start", signature: "" }
      ]
    }),
    chunk({
      reasoning: "answer now",
      reasoning_details: [
        {
          type: "thinking",
          index: 0,
          phase: "delta",
          thinking: "answer now"
        }
      ]
    }),
    chunk({
      reasoning_details: [
        {
          type: "thinking",
          index: 0,
          phase: "signature",
          signature: "sig-second-step"
        },
        { type: "thinking", index: 0, phase: "stop" }
      ]
    }),
    chunk({ content: "done" }),
    chunk({}, "stop"),
    "data: [DONE]\n\n"
  );
  const chat: Record<string, unknown> = {
    model: "m",
    messages: [],
    stream: true
  };
  let replayed: AnthropicNativeContentBlock[] | undefined;
  const composed = composeServerToolStream({
    chat,
    firstStep,
    runStep: async (next) => {
      const assistant = (next.messages as Array<Record<PropertyKey, unknown>>)[0];
      replayed = assistant?.[ANTHROPIC_MESSAGE_CONTENT] as
        | AnthropicNativeContentBlock[]
        | undefined;
      return secondStep;
    },
    serverToolNames: new Set(["web_search"]),
    executor: fakeExecutor({
      routekit: { text: "RouteKit result", citations: [] }
    })
  });
  const translated = await new Response(
    openAiSseToAnthropic(composed, "route-primary")
  ).text();
  assert.deepEqual(replayed?.map((block) => block.type), [
    "thinking",
    "tool_use"
  ]);
  assert.equal(
    (replayed?.[0] as { signature?: string } | undefined)?.signature,
    "sig-stream-loop"
  );
  assert.match(translated, /"thinking":"answer now"/);
  assert.match(translated, /"signature":"sig-second-step"/);
});

// ---- Anthropic dialect ----

const ANTHROPIC_TOOLS: AnthropicRequest["tools"] = [
  { type: "web_search_20250305", name: "web_search" },
  { name: "Bash", input_schema: { type: "object", properties: {} } },
  { type: "code_execution_20250522", name: "code_execution" }
];

test("anthropicToChat projects web_search when enabled and keeps code_execution dropped", () => {
  const body: AnthropicRequest = { messages: [{ role: "user", content: "hi" }], tools: ANTHROPIC_TOOLS };
  const chat = anthropicToChat(body, "local-model", { serverTools: true });
  const names = (chat.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name);
  assert.deepEqual(names.sort(), ["Bash", "web_search"]);
  const disabled = anthropicToChat(body, "local-model");
  const disabledNames = (disabled.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name);
  assert.deepEqual(disabledNames, ["Bash"]);
});

test("anthropicToChat replays echoed server_tool_use + web_search_tool_result as a tool exchange", () => {
  const body: AnthropicRequest = {
    messages: [
      { role: "user", content: "what is new?" },
      {
        role: "assistant",
        content: [
          { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "node lts" } },
          {
            type: "web_search_tool_result",
            tool_use_id: "srv_1",
            content: [{ type: "web_search_result", url: "https://nodejs.org", title: "Node.js", encrypted_content: "opaque" }]
          },
          { type: "text", text: "Node 24 is the LTS." }
        ]
      },
      { role: "user", content: "since when?" }
    ]
  };
  const chat = anthropicToChat(body, "local-model");
  const messages = chat.messages as Array<{ role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string }>;
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "tool", "assistant", "user"]);
  assert.equal(messages[2]?.tool_call_id, "srv_1");
  assert.match(String(messages[2]?.content), /nodejs\.org/);
  assert.ok(!String(messages[2]?.content).includes("opaque"), "encrypted_content is stripped");
  assert.equal(messages[3]?.content, "Node 24 is the LTS.");
});

test("chatToAnthropicMessage renders executed searches as native blocks", () => {
  const openai = {
    choices: [{ index: 0, message: { role: "assistant", content: "Node 24." }, finish_reason: "stop" }]
  };
  const rendered = chatToAnthropicMessage(openai as never, "route-primary", [
    {
      itemId: "srv_1",
      query: "node lts",
      status: "completed",
      outcome: {
        text: "Node 24 is LTS.",
        citations: [{ url: "https://nodejs.org", title: "Node.js" }],
        anthropicResultBlocks: [{ type: "web_search_result", url: "https://nodejs.org", title: "Node.js", encrypted_content: "e" }]
      }
    }
  ]);
  const content = rendered.content as Array<Record<string, unknown>>;
  assert.deepEqual(
    content.map((block) => block.type),
    ["server_tool_use", "web_search_tool_result", "text"]
  );
  assert.deepEqual(content[0]?.input, { query: "node lts" });
  // Anthropic-native result blocks pass through verbatim.
  assert.deepEqual((content[1]?.content as Array<{ encrypted_content?: string }>)[0]?.encrypted_content, "e");
});

test("openAiSseToAnthropic renders loop markers as native search blocks", async () => {
  const firstStep = sseStream(
    chunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "web_search", arguments: '{"query":"node lts"}' } }] }),
    chunk({}, "tool_calls"),
    "data: [DONE]\n\n"
  );
  const secondStep = sseStream(chunk({ content: "Node 24." }), chunk({}, "stop"), "data: [DONE]\n\n");
  const chat: Record<string, unknown> = { model: "m", messages: [], stream: true };
  const executor: WebSearchExecutor = {
    provider: "anthropic",
    model: "fake",
    async search() {
      return {
        text: "Node 24 is LTS.",
        citations: [{ url: "https://nodejs.org" }],
        anthropicResultBlocks: [{ type: "web_search_result", url: "https://nodejs.org", title: "Node.js" }]
      };
    }
  };
  const composed = composeServerToolStream({
    chat,
    firstStep,
    runStep: async () => secondStep,
    serverToolNames: new Set(["web_search"]),
    executor
  });
  const text = await new Response(openAiSseToAnthropic(composed, "route-primary")).text();
  assert.ok(text.includes('"type":"server_tool_use"'));
  assert.ok(text.includes('"type":"web_search_tool_result"'));
  assert.ok(text.includes('"url":"https://nodejs.org"'));
  assert.ok(!text.includes('"type":"tool_use","id":"call_1"'), "the server call never surfaces as a client tool_use");
  assert.ok(text.includes('"stop_reason":"end_turn"'));
  assert.equal(text.split("event: message_stop").length, 2, "exactly one message_stop");
});
