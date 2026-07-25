import assert from "node:assert/strict";
import { test } from "node:test";

import { responsesToChat } from "../adapters/responses.js";
import {
  AnthropicBackend,
  CodexResponsesBackend,
  GoogleGenAiBackend
} from "../provider-backends.js";
import { anthropicToChat } from "../adapters/anthropic.js";
import { OpenAiBackend } from "../backend.js";
import {
  ANTHROPIC_MESSAGE_CONTENT,
  ANTHROPIC_REQUEST_METADATA,
  REASONING_SELECTION,
  attachGoogleToolCallIndexes,
  attachReasoningSelection
} from "../adapters/openai-chat-wire.js";
import { ChatStreamAssembler } from "../sse/chat-assembler.js";
import { SseDecoder, SseParseError } from "../sse/parse.js";

function sse(
  events: readonly { event?: string; data: unknown }[],
  includeDone = false
): Response {
  const body = events
    .map(({ event, data }) =>
      `${event === undefined ? "" : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`
    )
    .join("") + (includeDone ? "data: [DONE]\n\n" : "");
  return new Response(body, {
    headers: { "content-type": "text/event-stream" }
  });
}

test("direct provider backends reject malformed reasoning controls before transport", async () => {
  const cases = [
    {
      name: "openai",
      make: (transport: typeof globalThis.fetch) => {
        const original = globalThis.fetch;
        globalThis.fetch = transport;
        return { backend: new OpenAiBackend({ baseUrl: "https://openai.test/v1", defaultModel: "m" }), restore: () => { globalThis.fetch = original; } };
      }
    },
    { name: "anthropic", make: (transport: typeof globalThis.fetch) => ({ backend: new AnthropicBackend({ baseUrl: "https://anthropic.test", apiKey: "x", defaultModel: "m", transport }), restore: () => {} }) },
    { name: "google", make: (transport: typeof globalThis.fetch) => ({ backend: new GoogleGenAiBackend({ baseUrl: "https://google.test", apiKey: "x", defaultModel: "m", transport }), restore: () => {} }) },
    { name: "codex", make: (transport: typeof globalThis.fetch) => ({ backend: new CodexResponsesBackend({ baseUrl: "https://codex.test", apiKey: "x", defaultModel: "m", transport }), restore: () => {} }) }
  ];
  for (const item of cases) {
    let calls = 0;
    const transport: typeof globalThis.fetch = async () => {
      calls += 1;
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    };
    const { backend, restore } = item.make(transport);
    try {
      for (const body of [
        { model: "m", messages: [], x_routekit: { version: 1, selection: { mode: "future" } } },
        { model: "m", messages: [], reasoning_effort: "" },
        { model: "m", messages: [], x_routekit: { version: 1, responses: { items: [null], includeEncryptedContent: true } } },
        { model: "m", messages: [], x_routekit: { version: 1, anthropic: { request: { thinking: { type: "enabled", budget_tokens: 0 } } } } },
        { model: "m", messages: [], x_routekit: { version: 1, selection: { mode: "disabled" }, anthropic: { request: { thinking: { type: "adaptive" } } } } },
        { model: "m", messages: [], x_routekit: { version: 1, selection: { mode: "budget", budgetTokens: 1024 }, anthropic: { request: { thinking: { type: "enabled", budget_tokens: 2048 } } } } },
        { model: "m", messages: [], x_routekit: { version: 1, selection: { mode: "effort", effort: "high" }, anthropic: { request: { thinking: { type: "adaptive" }, output_config: { effort: "low" } } } } },
        { model: "m", messages: [], x_routekit: { version: 1, selection: { mode: "adaptive" }, anthropic: { request: { thinking: { type: "adaptive" }, output_config: { effort: "high" } } } } },
        { model: "m", messages: [{ role: "assistant", content: "x", x_routekit: { version: 1, responses: { items: [null], includeEncryptedContent: true } } }] },
        { model: "m", messages: [{ role: "assistant", content: "x", x_routekit: [] }] },
        { model: "m", messages: [{ role: "assistant", content: "x", x_routekit: { version: 2 } }] },
        { model: "m", messages: [{ role: "assistant", content: "x", x_routekit: { version: 1, google: { toolCallIndexes: { call_1: "two" } } } }] },
        { model: "m", messages: [{ role: "assistant", content: "x", x_routekit: { version: 1, anthropic: { content: [null] } } }] }
      ]) {
        const response = await backend.chat(body);
        assert.equal(response.status, 400, item.name);
        const error = (await response.json()) as { error: { code?: string } };
        assert.ok(
          error.error.code === "invalid_reasoning_control" || error.error.code === "invalid_reasoning_metadata",
          item.name
        );
      }
      const symbolBody: Record<PropertyKey, unknown> = { model: "m", messages: [] };
      Object.defineProperty(symbolBody, REASONING_SELECTION, {
        value: { mode: "budget", budgetTokens: 0 },
        enumerable: true
      });
      const symbolResponse = await backend.chat(symbolBody);
      assert.equal(symbolResponse.status, 400, item.name);
      assert.equal(calls, 0, `${item.name} transport must not run`);
    } finally {
      restore();
    }
  }
});

test("direct provider backends reject malformed Anthropic metadata before transport", async () => {
  const malformedRequests: unknown[] = [
    { thinking: "enabled" },
    { thinking: { type: "enabled" } },
    { thinking: { type: "enabled", budget_tokens: 0 } },
    { thinking: { type: "enabled", budget_tokens: 1.5 } },
    { thinking: { type: "adaptive", display: "full" } },
    { thinking: { type: "disabled", budget_tokens: 1024 } },
    { thinking: { type: "disabled", display: null } },
    { output_config: [] },
    { output_config: { effort: "" } }
  ];
  const malformedBlocks: unknown[] = [
    null,
    { type: "text", text: 1 },
    { type: "thinking", thinking: 1, signature: "sig" },
    { type: "thinking", thinking: "private", signature: "" },
    { type: "redacted_thinking", data: "" },
    { type: "tool_use", id: "", name: "read", input: {} },
    { type: "tool_use", id: "tool_1", name: "", input: {} },
    { type: "tool_use", id: "tool_1", name: "read" }
  ];
  let calls = 0;
  const backend = new AnthropicBackend({
    baseUrl: "https://anthropic.test",
    apiKey: "x",
    defaultModel: "m",
    transport: async () => {
      calls += 1;
      return Response.json({ content: [], usage: {} });
    }
  });
  for (const request of malformedRequests) {
    const response = await backend.chat({
      model: "m",
      messages: [],
      x_routekit: { version: 1, anthropic: { request } }
    });
    assert.equal(response.status, 400);
    const error = (await response.json()) as { error: { code?: string; param?: string } };
    assert.equal(error.error.code, "invalid_reasoning_metadata");
    assert.match(error.error.param ?? "", /^x_routekit\.anthropic\.request/);
  }
  for (const block of malformedBlocks) {
    const response = await backend.chat({
      model: "m",
      messages: [{
        role: "assistant",
        content: "prior",
        x_routekit: { version: 1, anthropic: { content: [block] } }
      }]
    });
    assert.equal(response.status, 400);
    const error = (await response.json()) as { error: { code?: string; param?: string } };
    assert.equal(error.error.code, "invalid_reasoning_metadata");
    assert.match(error.error.param ?? "", /^messages\[0\]\.x_routekit\.anthropic\.content/);
  }
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const cyclicResponse = await backend.chat({
    model: "m",
    messages: [],
    x_routekit: { version: 1, anthropic: { request: { output_config: { future: cyclic } } } }
  });
  assert.equal(cyclicResponse.status, 400);

  const symbolRequest: Record<PropertyKey, unknown> = { model: "m", messages: [] };
  Object.defineProperty(symbolRequest, ANTHROPIC_REQUEST_METADATA, {
    value: { thinking: { type: "enabled", budget_tokens: 0 } },
    enumerable: true
  });
  assert.equal((await backend.chat(symbolRequest)).status, 400);
  const symbolMessage: Record<PropertyKey, unknown> = { role: "assistant", content: "prior" };
  Object.defineProperty(symbolMessage, ANTHROPIC_MESSAGE_CONTENT, {
    value: [{ type: "thinking", thinking: "private", signature: "" }],
    enumerable: true
  });
  assert.equal((await backend.chat({ model: "m", messages: [symbolMessage] })).status, 400);
  const accessorRequest: Record<PropertyKey, unknown> = { model: "m", messages: [] };
  Object.defineProperty(accessorRequest, ANTHROPIC_REQUEST_METADATA, {
    get: () => { throw new Error("must not execute"); },
    enumerable: true
  });
  assert.equal((await backend.chat(accessorRequest)).status, 400);
  assert.equal(calls, 0, "Anthropic transport must not run for malformed metadata");
});

test("Anthropic native and canonical reasoning controls require exact semantic agreement", async () => {
  const conflicting = [
    { selection: { mode: "disabled" }, request: { thinking: { type: "enabled", budget_tokens: 1024 } } },
    { selection: { mode: "disabled" }, request: { thinking: { type: "adaptive" } } },
    { selection: { mode: "budget", budgetTokens: 1024 }, request: { thinking: { type: "enabled", budget_tokens: 2048 } } },
    { selection: { mode: "effort", effort: "high" }, request: { thinking: { type: "adaptive" }, output_config: { effort: "low" } } },
    { selection: { mode: "adaptive" }, request: { thinking: { type: "adaptive" }, output_config: { effort: "high" } } },
    { selection: { mode: "auto" }, request: { thinking: { type: "disabled" } } }
  ];
  const matching = [
    { selection: { mode: "disabled" }, request: { thinking: { type: "disabled" } } },
    { selection: { mode: "adaptive" }, request: { thinking: { type: "adaptive" } } },
    { selection: { mode: "budget", budgetTokens: 1024 }, request: { thinking: { type: "enabled", budget_tokens: 1024 } } },
    { selection: { mode: "effort", effort: "high" }, request: { thinking: { type: "adaptive" }, output_config: { effort: "high" } } },
    { selection: { mode: "effort", effort: "high" }, request: { thinking: { type: "enabled", budget_tokens: 1024 }, output_config: { effort: "high" } } }
  ];
  let calls = 0;
  const outbound: Record<string, unknown>[] = [];
  const backend = new AnthropicBackend({
    baseUrl: "https://anthropic.test",
    apiKey: "x",
    defaultModel: "m",
    transport: async (_url, init) => {
      calls += 1;
      outbound.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json({ id: "msg", content: [{ type: "text", text: "ok" }], usage: {} });
    }
  });
  for (const item of conflicting) {
    const response = await backend.chat({
      model: "m", max_tokens: 4096, messages: [],
      x_routekit: { version: 1, selection: item.selection, anthropic: { request: item.request } }
    });
    assert.equal(response.status, 400);
    const error = (await response.json()) as { error: { code?: string; param?: string } };
    assert.equal(error.error.code, "invalid_reasoning_control");
    assert.equal(error.error.param, "x_routekit.anthropic.request");
  }
  assert.equal(calls, 0);
  for (const item of matching) {
    const response = await backend.chat({
      model: "m", max_tokens: 4096, messages: [{ role: "user", content: "go" }],
      x_routekit: { version: 1, selection: item.selection, anthropic: { request: item.request } }
    });
    assert.equal(response.status, 200);
  }
  assert.equal(calls, matching.length);
  assert.deepEqual(outbound.map((body) => ({ thinking: body.thinking, output_config: body.output_config })),
    matching.map((item) => ({
      thinking: item.request.thinking,
      output_config: "output_config" in item.request ? item.request.output_config : undefined
    }))
  );

  const symbolBody: Record<PropertyKey, unknown> = { model: "m", messages: [] };
  Object.defineProperty(symbolBody, REASONING_SELECTION, {
    value: { mode: "budget", budgetTokens: 1024 }, enumerable: true
  });
  Object.defineProperty(symbolBody, ANTHROPIC_REQUEST_METADATA, {
    value: { thinking: { type: "enabled", budget_tokens: 2048 } }, enumerable: true
  });
  const symbolResponse = await backend.chat(symbolBody);
  assert.equal(symbolResponse.status, 400);
  const symbolError = (await symbolResponse.json()) as { error: { code?: string; param?: string } };
  assert.equal(symbolError.error.code, "invalid_reasoning_control");
  assert.equal(symbolError.error.param, "x_routekit.anthropic.request");
  assert.equal(calls, matching.length);
});

test("canonical reasoning selection suppresses deprecated reasoning_effort", async () => {
  const canonical = [
    { mode: "auto" },
    { mode: "disabled" },
    { mode: "adaptive" },
    { mode: "budget", budgetTokens: 1024 },
    { mode: "effort", effort: "high" }
  ];
  let calls = 0;
  const backend = new AnthropicBackend({
    baseUrl: "https://anthropic.test", apiKey: "x", defaultModel: "m",
    transport: async () => { calls += 1; return Response.json({ content: [], usage: {} }); }
  });
  for (const selection of canonical) {
    const response = await backend.chat({
      model: "m", max_tokens: 4096, messages: [{ role: "user", content: "go" }],
      reasoning_effort: "legacy-conflict",
      x_routekit: { version: 1, selection }
    });
    assert.equal(response.status, 200, selection.mode);
  }
  assert.equal(calls, canonical.length);

  const nativeConflict = await backend.chat({
    model: "m", messages: [], reasoning_effort: "low",
    x_routekit: { version: 1, anthropic: { request: {
      thinking: { type: "adaptive" }, output_config: { effort: "high" }
    } } }
  });
  assert.equal(nativeConflict.status, 400);
  const error = (await nativeConflict.json()) as { error: { code?: string; param?: string } };
  assert.equal(error.error.code, "invalid_reasoning_control");
  assert.equal(error.error.param, "reasoning_effort");
  assert.equal(calls, canonical.length);
});

test("Anthropic output effort requires compatible thinking", async () => {
  let calls = 0;
  const backend = new AnthropicBackend({
    baseUrl: "https://anthropic.test", apiKey: "x", defaultModel: "m",
    transport: async () => { calls += 1; return Response.json({ content: [], usage: {} }); }
  });
  for (const request of [
    { output_config: { effort: "high" } },
    { thinking: { type: "disabled" }, output_config: { effort: "high" } }
  ]) {
    const response = await backend.chat({ model: "m", messages: [], x_routekit: { version: 1, anthropic: { request } } });
    assert.equal(response.status, 400);
    const error = (await response.json()) as { error: { code?: string; param?: string } };
    assert.equal(error.error.code, "invalid_reasoning_metadata");
    assert.equal(error.error.param, "x_routekit.anthropic.request.output_config.effort");
  }
  assert.equal(calls, 0);
});

test("Anthropic metadata variants and future JSON-safe fields egress exactly", async () => {
  const outbound: Record<string, unknown>[] = [];
  const backend = new AnthropicBackend({
    baseUrl: "https://anthropic.test",
    apiKey: "x",
    defaultModel: "m",
    transport: async (_url, init) => {
      outbound.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json({ id: "msg", content: [{ type: "text", text: "ok" }], usage: {} });
    }
  });
  const requests = [
    { thinking: { type: "enabled", budget_tokens: 1024, display: "summarized", future: { nested: [true, null] } }, output_config: { effort: "high", future: 1 } },
    { thinking: { type: "adaptive", display: "omitted" }, output_config: null },
    { thinking: { type: "disabled" } }
  ];
  for (const request of requests) {
    const response = await backend.chat({
      model: "m",
      max_tokens: 4096,
      messages: request === requests[0] ? [{ role: "user", content: "go" }, {
        role: "assistant",
        content: "prior",
        x_routekit: { version: 1, anthropic: { content: [{ type: "future_block", payload: { safe: true } }] } }
      }] : [{ role: "user", content: "go" }],
      x_routekit: { version: 1, anthropic: { request } }
    });
    assert.equal(response.status, 200);
  }
  assert.deepEqual(
    (outbound[0]?.messages as Array<{ content: unknown[] }> | undefined)?.[1]?.content,
    [{ type: "future_block", payload: { safe: true } }]
  );
  assert.deepEqual(outbound.map((body) => ({ thinking: body.thinking, output_config: body.output_config })), [
    { thinking: requests[0]?.thinking, output_config: requests[0]?.output_config },
    { thinking: requests[1]?.thinking, output_config: undefined },
    { thinking: requests[2]?.thinking, output_config: undefined }
  ]);
});

test("direct provider backends preserve valid reasoning controls", async () => {
  let openAiBody: Record<string, unknown> | undefined;
  const original = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    openAiBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ choices: [{ message: { content: "ok" } }] });
  };
  try {
    const openai = new OpenAiBackend({ baseUrl: "https://openai.test/v1", defaultModel: "m" });
    const response = await openai.chat({
      model: "m",
      messages: [{
        role: "assistant",
        content: "prior",
        x_routekit: {
          version: 1,
          responses: {
            items: [{ type: "reasoning", encrypted_content: "opaque" }],
            includeEncryptedContent: true
          },
          google: { toolCallIndexes: { call_1: 2 } },
          anthropic: { content: [{ type: "thinking", thinking: "private", signature: "sig" }] },
          future: { retained: true }
        }
      }],
      x_routekit: { version: 1, selection: { mode: "effort", effort: "high" } }
    });
    assert.equal(response.status, 200);
    assert.equal(openAiBody?.x_routekit, undefined, "provider boundary strips RouteKit metadata");
  } finally {
    globalThis.fetch = original;
  }
});


test("Anthropic egress preserves tools and normalizes the response", async () => {
  const original = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return Response.json({
      id: "msg_1",
      content: [
        { type: "text", text: "working" },
        { type: "tool_use", id: "tool_1", name: "read", input: { path: "a.ts" } }
      ],
      usage: { input_tokens: 4, output_tokens: 2 }
    });
  };
  try {
    const backend = new AnthropicBackend({
      baseUrl: "https://api.anthropic.test/v1",
      apiKey: "secret",
      defaultModel: "claude-test"
    });
    const response = await backend.chat({
      messages: [{ role: "user", content: "inspect" }],
      tools: [
        {
          type: "function",
          function: {
            name: "read",
            description: "read a file",
            parameters: { type: "object" }
          }
        }
      ]
    });
    assert.equal(request?.url, "https://api.anthropic.test/v1/messages");
    assert.equal(request?.headers.get("x-api-key"), "secret");
    const outbound = (await request?.json()) as {
      tools: Array<{ name: string }>;
    };
    assert.equal(outbound.tools[0]?.name, "read");
    const body = (await response.json()) as {
      choices: Array<{ message: { tool_calls: Array<{ function: { name: string } }> } }>;
      usage: { input_tokens: number };
    };
    assert.equal(body.choices[0]?.message.tool_calls[0]?.function.name, "read");
    assert.equal(body.usage.input_tokens, 4);
  } finally {
    globalThis.fetch = original;
  }
});

test("Anthropic egress drops blank turns and translates image parts", async () => {
  const original = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return Response.json({
      id: "msg_blank",
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1 }
    });
  };
  try {
    const backend = new AnthropicBackend({
      baseUrl: "https://api.anthropic.test/v1",
      apiKey: "secret",
      defaultModel: "claude-test"
    });
    await backend.chat({
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "" },
        { role: "user", content: [] },
        { role: "user", content: null },
        { role: "user", content: "   " },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAB" } }
          ]
        }
      ]
    });
    const outbound = (await request?.json()) as {
      system: string;
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    };
    assert.equal(outbound.system, "be brief");
    assert.deepEqual(
      outbound.messages.map((message) => message.role),
      ["user", "assistant", "user"]
    );
    assert.ok(outbound.messages.every((message) => message.content.length > 0));
    assert.deepEqual(outbound.messages[2]?.content, [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAB" } }
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test("Anthropic egress keeps a closing user turn when the caller's is blank", async () => {
  const original = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return Response.json({
      id: "msg_closing",
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1 }
    });
  };
  try {
    const backend = new AnthropicBackend({
      baseUrl: "https://api.anthropic.test/v1",
      apiKey: "secret",
      defaultModel: "claude-test"
    });
    await backend.chat({
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "" }
      ]
    });
    const outbound = (await request?.json()) as {
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    };
    assert.deepEqual(
      outbound.messages.map((message) => message.role),
      ["user", "assistant", "user"]
    );
    assert.equal(outbound.messages[2]?.content[0]?.type, "text");
    assert.ok(String(outbound.messages[2]?.content[0]?.text).trim().length > 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("Anthropic egress keeps tool calls on assistant turns without text", async () => {
  const original = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return Response.json({
      id: "msg_tools",
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1 }
    });
  };
  try {
    const backend = new AnthropicBackend({
      baseUrl: "https://api.anthropic.test/v1",
      apiKey: "secret",
      defaultModel: "claude-test"
    });
    await backend.chat({
      messages: [
        { role: "user", content: "read a.ts" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", function: { name: "read", arguments: "{\"path\":\"a.ts\"}" } }
          ]
        },
        { role: "tool", tool_call_id: "call_1", content: "" }
      ]
    });
    const outbound = (await request?.json()) as {
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    };
    assert.deepEqual(
      outbound.messages.map((message) => message.content[0]?.type),
      ["text", "tool_use", "tool_result"]
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("Anthropic egress preserves native thinking controls, signed history, and buffered blocks", async () => {
  const original = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return Response.json({
      id: "msg_think",
      content: [
        {
          type: "thinking",
          thinking: "native thought",
          signature: "sig-response"
        },
        { type: "redacted_thinking", data: "opaque-redaction" },
        {
          type: "tool_use",
          id: "tool_2",
          name: "read",
          input: { path: "b.ts" }
        }
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 8, output_tokens: 5 }
    });
  };
  try {
    const backend = new AnthropicBackend({
      baseUrl: "https://api.anthropic.test/v1",
      apiKey: "secret",
      defaultModel: "claude-test"
    });
    const chat = anthropicToChat(
      {
        model: "claude-test",
        max_tokens: 4096,
        thinking: {
          type: "enabled",
          budget_tokens: 2048,
          display: "summarized"
        },
        output_config: { effort: "high" },
        messages: [
          { role: "user", content: "inspect" },
          {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: "prior thought",
                signature: "sig-prior"
              },
              { type: "redacted_thinking", data: "prior-redaction" },
              {
                type: "tool_use",
                id: "tool_1",
                name: "read",
                input: { path: "a.ts" }
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool_1",
                content: "source"
              }
            ]
          }
        ],
        tools: [
          {
            name: "read",
            input_schema: { type: "object" }
          }
        ],
        tool_choice: { type: "tool", name: "read", disable_parallel_tool_use: true }
      },
      "claude-test"
    );
    const response = await backend.chat(chat);
    const outbound = (await request?.json()) as {
      max_tokens: number;
      thinking: Record<string, unknown>;
      output_config: Record<string, unknown>;
      tool_choice: Record<string, unknown>;
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    };
    assert.equal(outbound.max_tokens, 4096);
    assert.deepEqual(outbound.thinking, {
      type: "enabled",
      budget_tokens: 2048,
      display: "summarized"
    });
    assert.deepEqual(outbound.output_config, { effort: "high" });
    assert.deepEqual(outbound.tool_choice, {
      type: "tool",
      name: "read",
      disable_parallel_tool_use: true
    });
    assert.deepEqual(
      outbound.messages[1]?.content.map((block) => block.type),
      ["thinking", "redacted_thinking", "tool_use"]
    );
    assert.equal(outbound.messages[1]?.content[0]?.signature, "sig-prior");

    const normalized = (await response.json()) as {
      choices: Array<{
        finish_reason: string;
        message: {
          content: string | null;
          reasoning: string;
          reasoning_details: Array<Record<string, unknown>>;
        };
      }>;
    };
    assert.equal(normalized.choices[0]?.finish_reason, "tool_calls");
    assert.equal(normalized.choices[0]?.message.content, null);
    assert.equal(normalized.choices[0]?.message.reasoning, "native thought");
    assert.deepEqual(
      normalized.choices[0]?.message.reasoning_details.map((detail) => detail.type),
      ["thinking", "redacted_thinking"]
    );
    assert.equal(
      normalized.choices[0]?.message.reasoning_details[0]?.signature,
      "sig-response"
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("Anthropic egress preserves opaque effort and rejects impossible explicit budgets", async () => {
  const requests: Request[] = [];
  const backend = new AnthropicBackend({
    baseUrl: "https://api.anthropic.test/v1",
    apiKey: "secret",
    defaultModel: "claude-test",
    transport: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn"
      });
    }
  });
  const valid = await backend.chat({
    max_completion_tokens: 5000,
    reasoning_effort: "ultra",
    messages: [{ role: "user", content: "think" }]
  });
  assert.equal(valid.status, 200);
  const outbound = (await requests[0]?.json()) as {
    max_tokens: number;
    thinking: { type: string };
    output_config: { effort: string };
  };
  assert.equal(outbound.max_tokens, 5000);
  assert.deepEqual(outbound.thinking, { type: "adaptive" });
  assert.deepEqual(outbound.output_config, { effort: "ultra" });

  const invalidBody: Record<PropertyKey, unknown> = {
    max_completion_tokens: 1024,
    messages: [{ role: "user", content: "think" }]
  };
  attachReasoningSelection(invalidBody, {
    mode: "budget",
    budgetTokens: 1024
  });
  const invalid = await backend.chat(invalidBody);
  assert.equal(invalid.status, 400);
  assert.equal(requests.length, 1, "invalid thinking must fail before transport");
  assert.match(await invalid.text(), /less than max_tokens/);
});

test("Anthropic egress preserves native stop reasons and stop sequences", async () => {
  const backend = new AnthropicBackend({
    baseUrl: "https://api.anthropic.test/v1",
    apiKey: "secret",
    defaultModel: "claude-test",
    transport: async () =>
      Response.json({
        content: [{ type: "text", text: "bounded" }],
        stop_reason: "stop_sequence",
        stop_sequence: "<END>"
      })
  });
  const response = await backend.chat({
    messages: [{ role: "user", content: "bounded answer" }]
  });
  const canonical = (await response.json()) as {
    choices: Array<Record<string, unknown>>;
  };
  assert.equal(canonical.choices[0]?.finish_reason, "stop");
  assert.equal(canonical.choices[0]?.anthropic_stop_reason, "stop_sequence");
  assert.equal(canonical.choices[0]?.anthropic_stop_sequence, "<END>");
});

test("Anthropic egress replays signed canonical reasoning_details from OpenAI clients", async () => {
  let request: Request | undefined;
  const backend = new AnthropicBackend({
    baseUrl: "https://api.anthropic.test/v1",
    apiKey: "secret",
    defaultModel: "claude-test",
    transport: async (input, init) => {
      request = new Request(input, init);
      return Response.json({
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn"
      });
    }
  });
  await backend.chat({
    messages: [
      {
        role: "assistant",
        content: null,
        reasoning: "prior",
        reasoning_details: [
          {
            type: "thinking",
            index: 0,
            thinking: "prior",
            signature: "sig-canonical"
          }
        ],
        tool_calls: [
          {
            id: "tool_1",
            function: { name: "read", arguments: '{"path":"a.ts"}' }
          }
        ]
      },
      { role: "tool", tool_call_id: "tool_1", content: "source" }
    ]
  });
  const outbound = (await request?.json()) as {
    messages: Array<{ content: Array<Record<string, unknown>> }>;
  };
  assert.deepEqual(
    outbound.messages[0]?.content.map((block) => block.type),
    ["thinking", "tool_use"]
  );
  assert.equal(outbound.messages[0]?.content[0]?.signature, "sig-canonical");
});

test("Google GenAI egress maps content, usage, and API-key auth", async () => {
  const original = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return Response.json({
      candidates: [{ content: { parts: [
        { text: "answer" },
        { text: "must not leak", thought: "true", thoughtSignature: { bad: true } }
      ] } }],
      usageMetadata: {
        promptTokenCount: 3,
        candidatesTokenCount: 1,
        totalTokenCount: 4
      }
    });
  };
  try {
    const backend = new GoogleGenAiBackend({
      baseUrl: "https://generativelanguage.test/v1beta",
      apiKey: "google-secret",
      defaultModel: "gemini-test"
    });
    const response = await backend.chat({
      reasoning_effort: "deliberate",
      messages: [{ role: "user", content: "hello" }]
    });
    assert.match(request?.url ?? "", /models\/gemini-test:generateContent$/);
    assert.equal(request?.headers.get("x-goog-api-key"), "google-secret");
    const outbound = (await request?.json()) as {
      generationConfig: { thinkingConfig: { thinkingLevel: string } };
    };
    assert.equal(
      outbound.generationConfig.thinkingConfig.thinkingLevel,
      "deliberate"
    );
    const body = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { total_tokens: number };
    };
    assert.equal(body.choices[0]?.message.content, "answer");
    assert.equal(body.usage.total_tokens, 4);
  } finally {
    globalThis.fetch = original;
  }
});

test("Google GenAI separates thoughts and replays signed continuation parts", async () => {
  const original = globalThis.fetch;
  const requests: Request[] = [];
  globalThis.fetch = async (input, init) => {
    requests.push(new Request(input, init));
    return Response.json({
      candidates: [{ content: { parts: [
        { text: "private analysis", thought: true, thoughtSignature: "thought-sig" },
        { text: "visible answer" },
        {
          functionCall: { name: "search", args: { query: "routekit" } },
          thoughtSignature: "call-sig"
        }
      ] } }]
    });
  };
  try {
    const backend = new GoogleGenAiBackend({
      baseUrl: "https://generativelanguage.test/v1beta",
      apiKey: "google-secret",
      defaultModel: "gemini-test"
    });
    const first = await backend.chat({ messages: [{ role: "user", content: "solve" }] });
    const payload = (await first.json()) as {
      choices: Array<{ message: Record<string, unknown> }>;
    };
    const assistant = payload.choices[0]?.message as {
      content: string;
      reasoning: string;
      reasoning_details: Array<Record<string, unknown>>;
      tool_calls: Array<Record<string, unknown>>;
    };
    assert.equal(assistant.content, "visible answer");
    assert.equal(assistant.reasoning, "private analysis");
    assert.deepEqual(
      assistant.tool_calls.map((call) => (call as { index?: number }).index),
      [0],
      "OpenAI tool-call indexes are dense, independent of Google part position"
    );
    assert.deepEqual(assistant.reasoning_details, [
      {
        type: "google_thought",
        index: 0,
        thought: "private analysis",
        thoughtSignature: "thought-sig"
      },
      { type: "google_thought", index: 2, thoughtSignature: "call-sig" }
    ]);

    await backend.chat({
      messages: [
        { role: "user", content: "solve" },
        assistant,
        { role: "tool", tool_call_id: (assistant.tool_calls[0] as { id: string }).id, content: "result" }
      ]
    });
    const continuation = (await requests[1]?.json()) as {
      contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    };
    const replayed = continuation.contents.find((content) => content.role === "model")?.parts ?? [];
    assert.deepEqual(replayed, [
      { text: "private analysis", thought: true, thoughtSignature: "thought-sig" },
      { text: "visible answer" },
      {
        functionCall: { name: "search", args: { query: "routekit" } },
        thoughtSignature: "call-sig"
      }
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test("Google GenAI ignores malformed and unknown canonical thought metadata", async () => {
  const original = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return Response.json({ candidates: [{ content: { parts: [{ text: "answer" }] } }] });
  };
  try {
    const backend = new GoogleGenAiBackend({
      baseUrl: "https://generativelanguage.test/v1beta",
      apiKey: "google-secret",
      defaultModel: "gemini-test"
    });
    const response = await backend.chat({ messages: [{
      role: "assistant",
      content: "safe",
      reasoning_details: [
        { type: "google_thought", index: 0, thought: "secret", thoughtSignature: 42 },
        { type: "future_thought", index: 1, thoughtSignature: "unknown" }
      ]
    }] });
    const outbound = (await request?.json()) as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    assert.deepEqual(outbound.contents[0]?.parts, [{ text: "safe" }]);
    const payload = (await response.json()) as {
      choices: Array<{ message: Record<string, unknown> }>;
    };
    assert.equal(payload.choices[0]?.message.content, "answer");
    assert.equal(payload.choices[0]?.message.reasoning, undefined);
    assert.equal(payload.choices[0]?.message.reasoning_details, undefined);
  } finally {
    globalThis.fetch = original;
  }
});



test("Codex Responses egress replays encrypted reasoning and include around tool continuation", async () => {
  const original = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return Response.json({
      output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }]
    });
  };
  try {
    const backend = new CodexResponsesBackend({
      baseUrl: "https://chatgpt.test/backend-api/codex",
      apiKey: "oauth",
      defaultModel: "codex-test"
    });
    const responseChat = responsesToChat(
      {
        input: [
          { type: "reasoning", id: "rs_1", summary: [], content: null, encrypted_content: "opaque" },
          { type: "message", role: "assistant", content: "checking" },
          { type: "function_call", call_id: "call_1", name: "read", arguments: "{}" },
          { type: "function_call_output", call_id: "call_1", output: "source" }
        ],
        include: ["reasoning.encrypted_content"]
      },
      "codex-test"
    );
    await backend.chat(responseChat);
    const outbound = (await request?.json()) as {
      input: Array<Record<string, unknown>>;
      include?: string[];
    };
    assert.deepEqual(outbound.include, ["reasoning.encrypted_content"]);
    assert.deepEqual(outbound.input.map((item) => item.type ?? item.role), [
      "reasoning", "assistant", "function_call", "function_call_output"
    ]);
    assert.deepEqual(outbound.input[0], {
      type: "reasoning", id: "rs_1", summary: [], content: null, encrypted_content: "opaque"
    });
  } finally {
    globalThis.fetch = original;
  }
});

test("Codex Responses egress preserves subscription auth and tool output", async () => {
  const original = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return Response.json({
      id: "resp_1",
      output: [
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "considering the fix" }]
        },
        { type: "message", content: [{ type: "output_text", text: "done" }] },
        {
          type: "function_call",
          call_id: "call_1",
          name: "apply",
          arguments: "{\"patch\":\"x\"}"
        }
      ],
      usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 }
    });
  };
  try {
    const backend = new CodexResponsesBackend({
      baseUrl: "https://chatgpt.test/backend-api/codex",
      apiKey: "oauth",
      accountId: "account",
      defaultModel: "codex-test"
    });
    const response = await backend.chat({
      reasoning_effort: "deep",
      messages: [{ role: "user", content: "fix it" }],
      tools: [{ type: "function", function: { name: "apply" } }]
    });
    assert.equal(request?.url, "https://chatgpt.test/backend-api/codex/responses");
    assert.equal(request?.headers.get("authorization"), "Bearer oauth");
    assert.equal(request?.headers.get("chatgpt-account-id"), "account");
    const upstreamBody = (await request?.json()) as Record<string, unknown> | undefined;
    assert.equal(upstreamBody?.store, false);
    assert.deepEqual(upstreamBody?.reasoning, { effort: "deep" });
    const body = (await response.json()) as {
      choices: Array<{
        message: { content: string; reasoning: string; tool_calls: unknown[] };
      }>;
    };
    assert.equal(body.choices[0]?.message.content, "done");
    assert.equal(body.choices[0]?.message.reasoning, "considering the fix");
    assert.equal(body.choices[0]?.message.tool_calls.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("Codex subscription egress forces SSE and omits unsupported sampling", async () => {
  const original = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return sse([
      {
        event: "response.completed",
        data: {
          response: {
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "done" }]
              }
            ],
            usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 }
          }
        }
      }
    ]);
  };
  try {
    const backend = new CodexResponsesBackend({
      baseUrl: "https://chatgpt.test/backend-api/codex",
      apiKey: "oauth",
      defaultModel: "codex-test",
      forceStream: true,
      omitSampling: true
    });
    const response = await backend.chat({
      stream: false,
      max_tokens: 16,
      temperature: 0,
      messages: [{ role: "user", content: "reply" }]
    });
    const outbound = (await request?.json()) as Record<string, unknown>;
    assert.equal(outbound.stream, true);
    assert.equal("max_output_tokens" in outbound, false);
    assert.equal("temperature" in outbound, false);
    const body = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    assert.equal(body.choices[0]?.message.content, "done");
  } finally {
    globalThis.fetch = original;
  }
});

test("Codex subscription egress recovers output from completed stream items", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    sse([
      {
        data: {
          type: "response.output_item.done",
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "ok" }]
          },
          output_index: 0
        }
      },
      {
        data: {
          type: "response.completed",
          response: {
            output: [],
            usage: { input_tokens: 8, output_tokens: 5, total_tokens: 13 }
          }
        }
      }
    ]);
  try {
    const backend = new CodexResponsesBackend({
      baseUrl: "https://chatgpt.test/backend-api/codex",
      apiKey: "oauth",
      defaultModel: "gpt-5.4-mini",
      forceStream: true,
      omitSampling: true
    });
    const response = await backend.chat({
      stream: false,
      messages: [{ role: "user", content: "Say ok" }]
    });
    const body = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { completion_tokens: number };
    };
    assert.equal(body.choices[0]?.message.content, "ok");
    assert.equal(body.usage.completion_tokens, 5);
  } finally {
    globalThis.fetch = original;
  }
});

test("Codex subscription egress merges completed items into partial terminal output", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    sse([
      {
        event: "response.output_item.done",
        data: {
          item: {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "brief reasoning" }]
          },
          output_index: 0
        }
      },
      {
        event: "response.output_item.done",
        data: {
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "RouteKit works" }]
          },
          output_index: 1
        }
      },
      {
        event: "response.completed",
        data: {
          response: {
            output: [
              {
                type: "reasoning",
                summary: [{ type: "summary_text", text: "brief reasoning" }]
              }
            ],
            usage: { input_tokens: 8, output_tokens: 8, total_tokens: 16 }
          }
        }
      }
    ]);
  try {
    const backend = new CodexResponsesBackend({
      baseUrl: "https://chatgpt.test/backend-api/codex",
      apiKey: "oauth",
      defaultModel: "gpt-5.5",
      forceStream: true,
      omitSampling: true
    });
    const response = await backend.chat({
      stream: false,
      messages: [{ role: "user", content: "Reply with: RouteKit works" }]
    });
    const body = (await response.json()) as {
      choices: Array<{
        message: { content: string; reasoning: string };
      }>;
    };
    assert.equal(response.status, 200);
    assert.equal(body.choices[0]?.message.content, "RouteKit works");
    assert.equal(body.choices[0]?.message.reasoning, "brief reasoning");
  } finally {
    globalThis.fetch = original;
  }
});

test("Codex subscription streaming recovers text when only the completed item carries it", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    sse([
      {
        data: {
          type: "response.output_item.done",
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "RouteKit works" }]
          },
          output_index: 0
        }
      },
      {
        data: {
          type: "response.completed",
          response: {
            output: [],
            usage: { input_tokens: 8, output_tokens: 5, total_tokens: 13 }
          }
        }
      }
    ]);
  try {
    const backend = new CodexResponsesBackend({
      baseUrl: "https://chatgpt.test/backend-api/codex",
      apiKey: "oauth",
      defaultModel: "gpt-5.5",
      forceStream: true,
      omitSampling: true
    });
    const response = await backend.chat({
      stream: true,
      messages: [{ role: "user", content: "Reply with: RouteKit works" }]
    });
    const text = await response.text();
    assert.match(text, /"content":"RouteKit works"/);
    assert.match(text, /"finish_reason":"stop"/);
    assert.match(text, /"completion_tokens":5/);
  } finally {
    globalThis.fetch = original;
  }
});

test("Codex subscription streaming does not duplicate delta and completed-item text", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    sse([
      {
        event: "response.output_text.delta",
        data: { output_index: 0, delta: "RouteKit " }
      },
      {
        event: "response.output_item.done",
        data: {
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "RouteKit works" }]
          },
          output_index: 0
        }
      },
      {
        event: "response.completed",
        data: {
          response: {
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "RouteKit works" }]
              }
            ],
            usage: { input_tokens: 8, output_tokens: 5, total_tokens: 13 }
          }
        }
      }
    ]);
  try {
    const backend = new CodexResponsesBackend({
      baseUrl: "https://chatgpt.test/backend-api/codex",
      apiKey: "oauth",
      defaultModel: "gpt-5.5"
    });
    const response = await backend.chat({
      stream: true,
      messages: [{ role: "user", content: "Reply with: RouteKit works" }]
    });
    const decoder = new SseDecoder();
    const events = [
      ...decoder.feed(await response.text()),
      ...decoder.flush()
    ];
    const assembler = new ChatStreamAssembler();
    for (const event of events) assembler.push(event);
    assert.equal(assembler.result().content, "RouteKit works");
    assert.equal(assembler.result().finishReason, "stop");
  } finally {
    globalThis.fetch = original;
  }
});

test("Codex subscription egress rejects a silent reasoning-only completion", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    sse([
      {
        data: {
          type: "response.output_item.done",
          item: {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "internal reasoning" }]
          },
          output_index: 0
        }
      },
      {
        data: {
          type: "response.completed",
          response: {
            output: [],
            usage: {
              input_tokens: 22,
              output_tokens: 31,
              output_tokens_details: { reasoning_tokens: 22 },
              total_tokens: 53
            }
          }
        }
      }
    ]);
  try {
    const backend = new CodexResponsesBackend({
      baseUrl: "https://chatgpt.test/backend-api/codex",
      apiKey: "oauth",
      defaultModel: "gpt-5.5",
      forceStream: true,
      omitSampling: true
    });
    const response = await backend.chat({
      stream: false,
      messages: [{ role: "user", content: "Reply with: RouteKit works" }]
    });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      error: {
        message: "Codex completed without assistant content or tool calls",
        type: "upstream_empty_response"
      }
    });
  } finally {
    globalThis.fetch = original;
  }
});

test("Codex subscription streaming surfaces a silent reasoning-only completion as an error", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    sse([
      {
        event: "response.reasoning_summary_text.delta",
        data: { output_index: 0, delta: "internal reasoning" }
      },
      {
        event: "response.completed",
        data: {
          response: {
            output: [],
            usage: {
              input_tokens: 22,
              output_tokens: 31,
              output_tokens_details: { reasoning_tokens: 22 },
              total_tokens: 53
            }
          }
        }
      }
    ]);
  try {
    const backend = new CodexResponsesBackend({
      baseUrl: "https://chatgpt.test/backend-api/codex",
      apiKey: "oauth",
      defaultModel: "gpt-5.5"
    });
    const response = await backend.chat({
      stream: true,
      messages: [{ role: "user", content: "Reply with: RouteKit works" }]
    });
    const text = await response.text();
    assert.match(text, /"type":"upstream_empty_response"/);
    assert.doesNotMatch(text, /"finish_reason":"stop"/);
  } finally {
    globalThis.fetch = original;
  }
});

test("Codex subscription streaming surfaces terminal failure events", async () => {
  const original = globalThis.fetch;
  const backend = new CodexResponsesBackend({
    baseUrl: "https://chatgpt.test/backend-api/codex",
    apiKey: "oauth",
    defaultModel: "gpt-5.5"
  });
  try {
    for (const terminal of [
      { event: "response.failed", data: { response: { status: "failed" } } },
      {
        event: "response.incomplete",
        data: { response: { status: "incomplete" } }
      },
      {
        data: { type: "response.failed", response: { status: "failed" } }
      }
    ]) {
      globalThis.fetch = async () => sse([terminal]);
      const response = await backend.chat({
        stream: true,
        messages: [{ role: "user", content: "Reply with: RouteKit works" }]
      });
      const text = await response.text();
      assert.match(text, /"type":"upstream_error"/);
      assert.doesNotMatch(text, /"finish_reason":"stop"/);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("Anthropic streaming egress preserves tool calls and terminal usage", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    sse([
      {
        event: "message_start",
        data: {
          message: { usage: { input_tokens: 4 } }
        }
      },
      {
        event: "content_block_start",
        data: {
          index: 0,
          content_block: { type: "tool_use", id: "tool_1", name: "read", input: {} }
        }
      },
      {
        event: "content_block_delta",
        data: { index: 0, delta: { type: "input_json_delta", partial_json: "{\"path\":\"a.ts\"}" } }
      },
      {
        event: "message_delta",
        data: {
          delta: { stop_reason: "tool_use" },
          usage: { output_tokens: 2 }
        }
      }
    ], true);
  try {
    const backend = new AnthropicBackend({
      baseUrl: "https://api.anthropic.test/v1",
      apiKey: "secret",
      defaultModel: "claude-test"
    });
    const response = await backend.chat({
      stream: true,
      messages: [{ role: "user", content: "inspect" }],
      tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }]
    });
    const text = await response.text();
    assert.match(text, /"name":"read"/);
    assert.match(text, /\\"path\\":\\"a\.ts\\"/);
    assert.match(text, /"finish_reason":"tool_calls"/);
    assert.match(text, /"input_tokens":4/);
    assert.match(text, /"output_tokens":2/);
    assert.match(text, /data: \[DONE\]/);
    assert.equal(text.match(/data: \[DONE\]/g)?.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("Anthropic streaming egress preserves thinking lifecycle, signatures, and redactions", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    sse([
      {
        event: "content_block_start",
        data: {
          index: 0,
          content_block: { type: "thinking", thinking: "", signature: "" }
        }
      },
      {
        event: "content_block_delta",
        data: {
          index: 0,
          delta: { type: "thinking_delta", thinking: "native thought" }
        }
      },
      {
        event: "content_block_delta",
        data: {
          index: 0,
          delta: { type: "signature_delta", signature: "sig-stream" }
        }
      },
      { event: "content_block_stop", data: { index: 0 } },
      {
        event: "content_block_start",
        data: {
          index: 1,
          content_block: {
            type: "redacted_thinking",
            data: "opaque-stream"
          }
        }
      },
      { event: "content_block_stop", data: { index: 1 } },
      {
        event: "content_block_start",
        data: { index: 2, content_block: { type: "text", text: "" } }
      },
      {
        event: "content_block_delta",
        data: { index: 2, delta: { type: "text_delta", text: "answer" } }
      },
      { event: "content_block_stop", data: { index: 2 } },
      {
        event: "message_delta",
        data: {
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 4, output_tokens: 5 }
        }
      }
    ], true);
  try {
    const backend = new AnthropicBackend({
      baseUrl: "https://api.anthropic.test/v1",
      apiKey: "secret",
      defaultModel: "claude-test"
    });
    const response = await backend.chat({
      stream: true,
      messages: [{ role: "user", content: "think" }]
    });
    const text = await response.text();
    assert.match(text, /"reasoning":"native thought"/);
    assert.match(text, /"phase":"start"/);
    assert.match(text, /"phase":"signature","signature":"sig-stream"/);
    assert.match(text, /"phase":"stop"/);
    assert.match(text, /"type":"redacted_thinking"/);
    assert.match(text, /"data":"opaque-stream"/);
    assert.match(text, /"content":"answer"/);
    assert.match(text, /"finish_reason":"stop"/);
  } finally {
    globalThis.fetch = original;
  }
});

test("Google streaming egress preserves function history, tools, and usage", async () => {
  const original = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return sse([
      {
        data: {
          candidates: [
            {
              content: {
                parts: [
                  { text: "stream thought", thought: true, thoughtSignature: "stream-thought-sig" },
                  { text: "stream answer" },
                  {
                    functionCall: { name: "search", args: { query: "routekit" } },
                    thoughtSignature: "stream-call-sig"
                  }
                ]
              },
              finishReason: "STOP"
            }
          ],
          usageMetadata: {
            promptTokenCount: 5,
            candidatesTokenCount: 1,
            totalTokenCount: 6
          }
        }
      }
    ]);
  };
  try {
    const backend = new GoogleGenAiBackend({
      baseUrl: "https://generativelanguage.test/v1beta",
      apiKey: "google-secret",
      defaultModel: "gemini-test"
    });
    const response = await backend.chat({
      stream: true,
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_1",
              function: { name: "search", arguments: "{\"query\":\"first\"}" }
            }
          ]
        },
        { role: "tool", tool_call_id: "call_1", content: "first result" }
      ],
      tools: [
        {
          type: "function",
          function: { name: "search", parameters: { type: "object" } }
        }
      ]
    });
    assert.match(request?.url ?? "", /models\/gemini-test:streamGenerateContent\?alt=sse$/);
    const outbound = (await request?.json()) as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>;
      tools: Array<{ functionDeclarations: Array<{ name: string }> }>;
    };
    assert.equal(outbound.tools[0]?.functionDeclarations[0]?.name, "search");
    assert.ok(outbound.contents.some((content) => content.parts.some((part) => "functionCall" in part)));
    assert.ok(outbound.contents.some((content) => content.parts.some((part) => "functionResponse" in part)));
    const text = await response.text();
    assert.match(text, /"reasoning":"stream thought"/);
    assert.match(text, /"content":"stream answer"/);
    assert.match(text, /"type":"google_thought"/);
    assert.match(text, /"thoughtSignature":"stream-thought-sig"/);
    assert.match(text, /"thoughtSignature":"stream-call-sig"/);
    assert.match(text, /"name":"search"/);
    assert.match(text, /"finish_reason":"stop"/);
    assert.match(text, /"total_tokens":6/);
  } finally {
    globalThis.fetch = original;
  }
});

test("Google streaming assigns stable indexes across restarting local part arrays", async () => {
  const original = globalThis.fetch;
  const requests: Request[] = [];
  let invocation = 0;
  globalThis.fetch = async (input, init) => {
    requests.push(new Request(input, init));
    invocation += 1;
    if (invocation === 1) {
      return sse([
        { data: { candidates: [{ content: { parts: [
          { text: "think ", thought: true }
        ] } }] } },
        { data: { candidates: [{ content: { parts: [
          { text: "carefully", thought: true, thoughtSignature: "thought-sig" }
        ] } }] } },
        { data: { candidates: [{ content: { parts: [
          { text: "visible answer" }
        ] } }] } },
        { data: { candidates: [{ content: { parts: [
          {
            functionCall: { name: "web_search", args: { query: "routekit" } },
            thoughtSignature: "call-sig"
          }
        ] } }] } },
        { data: { candidates: [{ content: { parts: [
          { text: "compare alternatives", thought: true, thoughtSignature: "second-thought-sig" }
        ] } }] } },
        { data: { candidates: [{ content: { parts: [
          {
            functionCall: { name: "web_search", args: { query: "routekit" } },
            thoughtSignature: "second-call-sig"
          }
        ] }, finishReason: "STOP" }] } }
      ]);
    }
    return sse([{ data: {
      candidates: [{ content: { parts: [{ text: "done" }] }, finishReason: "STOP" }]
    } }]);
  };
  try {
    const backend = new GoogleGenAiBackend({
      baseUrl: "https://generativelanguage.test/v1beta",
      apiKey: "google-secret",
      defaultModel: "gemini-test"
    });
    const first = await backend.chat({
      stream: true,
      messages: [{ role: "user", content: "solve" }],
      tools: [{
        type: "function",
        function: { name: "web_search", parameters: { type: "object" } }
      }]
    });
    const assembler = new ChatStreamAssembler();
    for (const event of new SseDecoder().feed(new TextEncoder().encode(await first.text()))) {
      assembler.push(event);
    }
    const turn = assembler.result();
    assert.equal(turn.reasoning, "think carefullycompare alternatives");
    assert.deepEqual(turn.reasoningDetails, [
      {
        type: "google_thought",
        index: 0,
        thought: "think carefully",
        thoughtSignature: "thought-sig"
      },
      { type: "google_thought", index: 2, thoughtSignature: "call-sig" },
      {
        type: "google_thought",
        index: 3,
        thought: "compare alternatives",
        thoughtSignature: "second-thought-sig"
      },
      { type: "google_thought", index: 4, thoughtSignature: "second-call-sig" }
    ]);
    assert.equal(turn.toolCalls.length, 2);
    assert.deepEqual(turn.toolCalls.map((call) => call.index), [0, 1]);
    assert.deepEqual(turn.toolCalls.map((call) => call.name), ["web_search", "web_search"]);
    assert.deepEqual(turn.toolCalls.map((call) => call.providerIndex), [2, 4]);

    await backend.chat({
      stream: true,
      messages: [
        { role: "user", content: "solve" },
        (() => {
          const assistant: Record<PropertyKey, unknown> = {
            role: "assistant",
            content: turn.content,
            reasoning_details: turn.reasoningDetails,
            tool_calls: turn.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.arguments }
            }))
          };
          attachGoogleToolCallIndexes(
            assistant,
            Object.fromEntries(
              turn.toolCalls.flatMap((call) =>
                call.id !== undefined && call.providerIndex !== undefined
                  ? [[call.id, call.providerIndex]]
                  : []
              )
            )
          );
          return assistant;
        })(),
        { role: "tool", tool_call_id: turn.toolCalls[0]?.id, content: "first result" },
        { role: "tool", tool_call_id: turn.toolCalls[1]?.id, content: "second result" }
      ]
    });
    const continuation = (await requests[1]?.json()) as {
      contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    };
    const replayed = continuation.contents.find((entry) => entry.role === "model")?.parts ?? [];
    assert.deepEqual(replayed, [
      { text: "think carefully", thought: true, thoughtSignature: "thought-sig" },
      { text: "visible answer" },
      {
        functionCall: { name: "web_search", args: { query: "routekit" } },
        thoughtSignature: "call-sig"
      },
      {
        text: "compare alternatives",
        thought: true,
        thoughtSignature: "second-thought-sig"
      },
      {
        functionCall: { name: "web_search", args: { query: "routekit" } },
        thoughtSignature: "second-call-sig"
      }
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test("Codex streaming egress preserves Responses tool history and deltas", async () => {
  const original = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return sse([
      {
        event: "response.reasoning_summary_text.delta",
        data: { delta: "considering the patch" }
      },
      {
        event: "response.output_item.added",
        data: {
          output_index: 0,
          item: {
            type: "function_call",
            id: "item_1",
            call_id: "call_2",
            name: "apply"
          }
        }
      },
      {
        event: "response.function_call_arguments.delta",
        data: { output_index: 0, delta: "{\"patch\":\"x\"}" }
      },
      {
        event: "response.completed",
        data: {
          response: {
            usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 }
          }
        }
      }
    ]);
  };
  try {
    const backend = new CodexResponsesBackend({
      baseUrl: "https://chatgpt.test/backend-api/codex",
      apiKey: "oauth",
      accountId: "account",
      defaultModel: "codex-test"
    });
    const response = await backend.chat({
      stream: true,
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_1",
              function: { name: "read", arguments: "{\"path\":\"a.ts\"}" }
            }
          ]
        },
        { role: "tool", tool_call_id: "call_1", content: "source" }
      ],
      tools: [
        {
          type: "function",
          function: { name: "apply", parameters: { type: "object" } }
        }
      ]
    });
    const outbound = (await request?.json()) as {
      input: Array<Record<string, unknown>>;
      tools: Array<Record<string, unknown>>;
    };
    assert.ok(outbound.input.some((item) => item.type === "function_call"));
    assert.ok(outbound.input.some((item) => item.type === "function_call_output"));
    assert.deepEqual(outbound.tools[0], {
      type: "function",
      name: "apply",
      parameters: { type: "object" }
    });
    const text = await response.text();
    assert.match(text, /"reasoning":"considering the patch"/);
    assert.match(text, /"name":"apply"/);
    assert.match(text, /\\"patch\\":\\"x\\"/);
    assert.match(text, /"finish_reason":"tool_calls"/);
    assert.match(text, /"total_tokens":9/);
  } finally {
    globalThis.fetch = original;
  }
});

test("provider streaming surfaces malformed and truncated SSE", async () => {
  const original = globalThis.fetch;
  const backend = new CodexResponsesBackend({
    baseUrl: "https://chatgpt.test/backend-api/codex",
    apiKey: "oauth",
    defaultModel: "codex-test"
  });
  try {
    for (const body of [
      "event: response.output_text.delta\ndata: {malformed}\n\n",
      'event: response.output_text.delta\ndata: {"delta":"partial"}'
    ]) {
      globalThis.fetch = async () =>
        new Response(body, {
          headers: { "content-type": "text/event-stream" }
        });
      const response = await backend.chat({
        stream: true,
        messages: [{ role: "user", content: "hello" }]
      });
      await assert.rejects(response.text(), SseParseError);
    }
  } finally {
    globalThis.fetch = original;
  }
});


test("ordinary OpenAI Chat egress strips RouteKit provider-only envelopes", async () => {
  const original = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return Response.json({ choices: [{ message: { content: "ok" } }] });
  };
  try {
    const backend = new OpenAiBackend({
      baseUrl: "https://api.openai.test/v1",
      apiKey: "secret",
      defaultModel: "gpt-test"
    });
    await backend.chat({
      model: "gpt-test",
      messages: [
        {
          role: "assistant",
          content: null,
          x_routekit: {
            version: 1,
            anthropic: {
              content: [{ type: "thinking", thinking: "private", signature: "sig" }]
            }
          }
        }
      ],
      x_routekit: {
        version: 1,
        selection: { mode: "effort", effort: "high" },
        anthropic: {
          request: {
            thinking: { type: "adaptive" },
            output_config: { effort: "high" }
          }
        }
      }
    });
    const outbound = (await request?.json()) as {
      x_routekit?: unknown;
      messages?: Array<{ x_routekit?: unknown }>;
    };
    assert.equal(outbound.x_routekit, undefined);
    assert.equal(outbound.messages?.[0]?.x_routekit, undefined);
  } finally {
    globalThis.fetch = original;
  }
});
