import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cursorModelAliasId,
  cursorModelVariants,
  isCursorChatBody,
  resolveCursorModelAlias,
  resolveCursorModelSelection,
  translateCursorRequest
} from "../adapters/cursor.js";
import {
  REASONING_SELECTION,
  reasoningSelectionErrorOf,
  reasoningSelectionOf,
  withReasoningSelection
} from "../adapters/openai-chat-wire.js";
import type { Backend } from "../backend.js";
import { startGateway } from "../server.js";

const cursorBody = {
  model: "route-primary",
  input: [
    { type: "message", role: "developer", content: "You are a coding agent." },
    { type: "message", role: "user", content: [{ type: "input_text", text: "fix the bug" }] },
    {
      type: "function_call",
      call_id: "call_1",
      name: "read_file",
      arguments: "{\"path\":\"a.ts\"}"
    },
    { type: "function_call_output", call_id: "call_1", output: "source" }
  ],
  stream: true,
  tools: [
    {
      type: "function",
      name: "read_file",
      parameters: { type: "object" }
    }
  ]
};

test("Cursor hybrid requests translate to chat messages and tools", () => {
  assert.equal(isCursorChatBody(cursorBody), true);
  const translated = translateCursorRequest(cursorBody);
  assert.equal(translated.model, "route-primary");
  assert.equal(translated.stream, true);
  assert.deepEqual(translated.messages, [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: "fix the bug" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" }
        }
      ]
    },
    { role: "tool", tool_call_id: "call_1", content: "source" }
  ]);
  assert.equal(
    (translated.tools as Array<{ function: { name: string } }>)[0]?.function.name,
    "read_file"
  );
});

test("Cursor model names namespace under routekit/ and resolve back", () => {
  assert.equal(cursorModelAliasId("claude-code/claude-fable-5"), "claude-code-claude-fable-5");
  assert.equal(
    cursorModelAliasId("openrouter/moonshotai/kimi-k2-thinking"),
    "openrouter-moonshotai-kimi-k2-thinking",
    "legacy dashed spelling still respells every slash"
  );

  const served = ["claude-code/claude-fable-5", "openai/gpt-4o", "route-primary"];
  // Namespaced Cursor-facing spelling.
  assert.equal(
    resolveCursorModelAlias("routekit/claude-code/claude-fable-5", served),
    "claude-code/claude-fable-5"
  );
  assert.equal(resolveCursorModelAlias("routekit/openai/gpt-4o", served), "openai/gpt-4o");
  assert.equal(resolveCursorModelAlias("routekit/route-primary", served), "route-primary");
  // Legacy 0.9.6 dashed spelling still resolves.
  assert.equal(
    resolveCursorModelAlias("claude-code-claude-fable-5", served),
    "claude-code/claude-fable-5"
  );
  assert.equal(resolveCursorModelAlias("openai-gpt-4o", served), "openai/gpt-4o");
  // Served-as-spelled ids and unknown names never rewrite.
  assert.equal(resolveCursorModelAlias("route-primary", served), undefined);
  assert.equal(resolveCursorModelAlias("claude-fable-5", served), undefined);
  assert.equal(resolveCursorModelAlias("routekit/", served), undefined);
  assert.equal(resolveCursorModelAlias(undefined, served), undefined);
});

test("Cursor exposes and resolves reasoning effort model variants", () => {
  const reasoning = {
    status: "supported" as const,
    efforts: [
      { id: "low" },
      { id: "high", aliases: ["max"] },
      { id: "high" }
    ],
    provenance: "provider" as const
  };
  assert.deepEqual(cursorModelVariants("openai/gpt-5.5", reasoning), [
    { model: "routekit/openai/gpt-5.5" },
    { model: "routekit/openai/gpt-5.5:low", reasoningEffort: "low" },
    { model: "routekit/openai/gpt-5.5:high", reasoningEffort: "high" }
  ]);
  assert.deepEqual(cursorModelVariants("openai/gpt-4o", undefined), [
    { model: "routekit/openai/gpt-4o" }
  ]);

  const served = ["openai/gpt-5.5", "openai/literal:high"];
  const capabilities = (model: string) =>
    model === "openai/gpt-5.5" ? reasoning : undefined;
  assert.deepEqual(
    resolveCursorModelSelection(
      "routekit/openai/gpt-5.5:high",
      served,
      capabilities
    ),
    { model: "openai/gpt-5.5", reasoningEffort: "high" }
  );
  assert.deepEqual(
    resolveCursorModelSelection("openai/gpt-5.5:max", served, capabilities),
    { model: "openai/gpt-5.5", reasoningEffort: "high" }
  );
  assert.deepEqual(
    resolveCursorModelSelection("routekit/openai/literal:high", served, capabilities),
    { model: "openai/literal:high" },
    "an exact provider model id wins over suffix parsing"
  );
  assert.equal(
    resolveCursorModelSelection(
      "routekit/openai/gpt-5.5:unknown",
      served,
      capabilities
    ),
    undefined
  );
});

test("Cursor hybrid detection rejects unrelated bodies", () => {
  assert.equal(isCursorChatBody({ input: "hello" }), true);
  assert.equal(isCursorChatBody({ messages: [] }), true);
  assert.equal(isCursorChatBody({ model: "route-primary" }), false);
  assert.equal(isCursorChatBody(null), false);
});

test("RouteKit serves the Cursor hybrid through its neutral HTTP boundary", async () => {
  let received: unknown;
  const backend: Backend = {
    defaultModel: "route-primary",
    chat(body) {
      received = body;
      return Promise.resolve(
        Response.json({
          id: "chatcmpl_1",
          object: "chat.completion",
          model: "route-primary",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "done" },
              finish_reason: "stop"
            }
          ]
        })
      );
    },
    models: () =>
      Promise.resolve(
        Response.json({
          object: "list",
          data: [{ id: "route-primary", object: "model" }]
        })
      ),
    embeddings: () => Promise.resolve(new Response(null, { status: 501 }))
  };
  const gateway = await startGateway({ backend });
  try {
    const response = await fetch(`${gateway.url()}/v1/cursor/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...cursorBody, stream: false })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(received, {
      ...translateCursorRequest({ ...cursorBody, stream: false }),
      model: "route-primary"
    });

    const models = await fetch(`${gateway.url()}/v1/cursor/models`);
    assert.equal(models.status, 200);
    assert.deepEqual(
      ((await models.json()) as { data: Array<{ id: string }> }).data.map((model) => model.id),
      ["routekit/route-primary"]
    );
  } finally {
    await gateway.close();
  }
});

test("Cursor hybrid forwards effort and preserves Chat reasoning and usage", async () => {
  let received: Record<string, unknown> | undefined;
  const upstream = {
    id: "chatcmpl_reasoning",
    object: "chat.completion",
    model: "openai/gpt-5.5",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: "answer",
        reasoning: "hidden-compatible-field",
        reasoning_content: "display summary"
      },
      finish_reason: "stop"
    }],
    usage: {
      prompt_tokens: 11,
      completion_tokens: 9,
      total_tokens: 20,
      prompt_tokens_details: { cached_tokens: 6 },
      completion_tokens_details: { reasoning_tokens: 7 }
    }
  };
  const backend: Backend = {
    defaultModel: "openai/gpt-5.5",
    chat(body) {
      received = body as Record<string, unknown>;
      return Promise.resolve(Response.json(upstream));
    },
    models: () => Promise.resolve(Response.json({ object: "list", data: [] })),
    embeddings: () => Promise.resolve(new Response(null, { status: 501 }))
  };
  const gateway = await startGateway({ backend });
  try {
    const response = await fetch(`${gateway.url()}/v1/cursor/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-5.5",
        input: [
          { type: "message", role: "user", content: "solve" },
          { type: "reasoning", summary: [{ type: "summary_text", text: "old" }] }
        ],
        reasoning: { effort: "none" },
        stream: false
      })
    });
    assert.equal(response.status, 200);
    assert.equal(received?.reasoning_effort, "none");
    assert.deepEqual(received?.messages, [{ role: "user", content: "solve" }]);
    assert.deepEqual(await response.json(), upstream);
  } finally {
    await gateway.close();
  }
});

test("Cursor hybrid validates and propagates x_routekit reasoning controls", async () => {
  let calls = 0;
  let received: Record<string, unknown> | undefined;
  const backend: Backend = {
    defaultModel: "openai/gpt-5.5",
    chat(body) { calls += 1; received = body as Record<string, unknown>; return Promise.resolve(Response.json({ choices: [] })); },
    models: () => Promise.resolve(Response.json({ data: [] })),
    embeddings: () => Promise.resolve(new Response(null, { status: 501 }))
  };
  const gateway = await startGateway({ backend });
  try {
    for (const body of [
      {
        input: "hello",
        reasoning: { effort: "high" },
        x_routekit: { version: 1, selection: { mode: "future" } }
      },
      {
        input: "hello",
        reasoning: { effort: "budget" },
        x_routekit: { version: 1, selection: { mode: "budget", budgetTokens: 0 } }
      },
      {
        input: "hello",
        x_routekit: { version: 1, responses: { items: [null], includeEncryptedContent: true } }
      }
    ]) {
      const malformed = await fetch(`${gateway.url()}/v1/cursor/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      assert.equal(malformed.status, 400);
      const code = ((await malformed.json()) as { error: { code: string } }).error.code;
      assert.ok(code === "invalid_reasoning_control" || code === "invalid_reasoning_metadata");
    }
    assert.equal(calls, 0);

    const selections = [
      { mode: "auto" }, { mode: "disabled" }, { mode: "adaptive" },
      { mode: "budget", budgetTokens: 2048 }, { mode: "effort", effort: "canonical" }
    ] as const;
    for (const selection of selections) {
      const response = await fetch(`${gateway.url()}/v1/cursor/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: "hello", reasoning: { effort: "native" },
          x_routekit: { version: 1, selection }
        })
      });
      assert.equal(response.status, 200, selection.mode);
      assert.deepEqual(reasoningSelectionOf(received), selection);
      assert.equal(received?.reasoning_effort, undefined);
    }
    const native = await fetch(`${gateway.url()}/v1/cursor/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hello", reasoning: { effort: "native" } })
    });
    assert.equal(native.status, 200);
    assert.deepEqual(reasoningSelectionOf(received), { mode: "effort", effort: "native" });
    assert.equal(received?.reasoning_effort, "native");
    assert.equal(calls, selections.length + 1);
  } finally {
    await gateway.close();
  }
});


test("Cursor symbol auto suppresses native effort", () => {
  const body: Record<PropertyKey, unknown> = { input: "hello", reasoning: { effort: "native" } };
  Object.defineProperty(body, REASONING_SELECTION, {
    value: { mode: "auto" }, enumerable: true
  });
  const translated = translateCursorRequest(body as Record<string, unknown>);
  assert.deepEqual(reasoningSelectionOf(translated), { mode: "auto" });
  assert.equal(translated.reasoning_effort, undefined);
});

test("Cursor translation preserves malformed symbol selection before native effort", () => {
  const body: Record<PropertyKey, unknown> = {
    input: "hello",
    reasoning: { effort: "high" }
  };
  Object.defineProperty(body, REASONING_SELECTION, {
    value: { mode: "effort", effort: "" },
    enumerable: true
  });
  const translated = translateCursorRequest(body as Record<string, unknown>);
  assert.match(reasoningSelectionErrorOf(translated) ?? "", /effort must be a non-empty string/);
});


test("Cursor authoritative reasoning selection clones non-configurable metadata", () => {
  const source: Record<PropertyKey, unknown> = {
    reasoning_effort: "stale",
    x_routekit: { version: 1, trace: { id: "keep" }, selection: { mode: "auto" } }
  };
  Object.defineProperty(source, REASONING_SELECTION, {
    value: { mode: "auto" },
    enumerable: true
  });
  const replaced = withReasoningSelection(
    source as Record<string, unknown>,
    { mode: "effort", effort: "high" }
  );
  assert.notEqual(replaced, source);
  assert.deepEqual(reasoningSelectionOf(source), { mode: "auto" });
  assert.deepEqual(reasoningSelectionOf(replaced), { mode: "effort", effort: "high" });
  assert.equal(replaced.reasoning_effort, "high");
  assert.deepEqual(replaced.x_routekit, {
    version: 1,
    trace: { id: "keep" },
    selection: { mode: "effort", effort: "high" }
  });
});

test("Cursor route advertises reasoning variants and applies their effort", async () => {
  let received: Record<string, unknown> | undefined;
  const reasoning = {
    status: "supported" as const,
    efforts: [{ id: "low" }, { id: "high" }],
    defaultEffort: "low",
    provenance: "provider" as const
  };
  const backend: Backend = {
    defaultModel: "claude-code/claude-fable-5",
    chat(body) {
      received = body as Record<string, unknown>;
      return Promise.resolve(
        Response.json({
          id: "chatcmpl_2",
          object: "chat.completion",
          model: "claude-code/claude-fable-5",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "done" },
              finish_reason: "stop"
            }
          ]
        })
      );
    },
    models: () =>
      Promise.resolve(
        Response.json({
          object: "list",
          data: [
            { id: "claude-code/claude-fable-5", object: "model" },
            { id: "openai/gpt-4o", object: "model", reasoning },
            { id: "gemini-proxy/gemini-zzz-9", object: "model" }
          ]
        })
      ),
    listModelIds: () => [
      "claude-code/claude-fable-5",
      "openai/gpt-4o",
      "gemini-proxy/gemini-zzz-9"
    ],
    reasoningCapabilities: (model) =>
      model === "openai/gpt-4o" ? reasoning : undefined,
    embeddings: () => Promise.resolve(new Response(null, { status: 501 }))
  };
  const gateway = await startGateway({ backend });
  try {
    const namespaced = await fetch(`${gateway.url()}/v1/cursor/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "routekit/claude-code/claude-fable-5",
        messages: [{ role: "user", content: "hi" }]
      })
    });
    assert.equal(namespaced.status, 200);
    assert.equal(received?.model, "claude-code/claude-fable-5");

    const high = await fetch(`${gateway.url()}/v1/cursor/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "routekit/openai/gpt-4o:high",
        reasoning: { effort: "low" },
        input: "hi"
      })
    });
    assert.equal(high.status, 200);
    assert.equal(received?.model, "openai/gpt-4o");
    assert.equal(
      received?.reasoning_effort,
      "high",
      "the selected model variant overrides Cursor's omitted or stale effort"
    );
    assert.deepEqual(reasoningSelectionOf(received), {
      mode: "effort",
      effort: "high"
    });

    const malformed = await fetch(`${gateway.url()}/v1/cursor/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "routekit/openai/gpt-4o:high",
        reasoning: {},
        input: "hi"
      })
    });
    assert.equal(malformed.status, 200);
    assert.equal(reasoningSelectionErrorOf(received), undefined);
    assert.equal(received?.reasoning_effort, "high");

    const automatic = await fetch(`${gateway.url()}/v1/cursor/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "routekit/openai/gpt-4o",
        reasoning_effort: "high",
        messages: [{ role: "user", content: "hi" }]
      })
    });
    assert.equal(automatic.status, 200);
    assert.equal(received?.model, "openai/gpt-4o");
    assert.equal(received?.reasoning_effort, undefined);
    assert.deepEqual(reasoningSelectionOf(received), { mode: "auto" });

    // Legacy dashed spelling still resolves for one-release back-compat.
    const legacy = await fetch(`${gateway.url()}/v1/cursor/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-code-claude-fable-5",
        messages: [{ role: "user", content: "hi" }]
      })
    });
    assert.equal(legacy.status, 200);
    assert.equal(received?.model, "claude-code/claude-fable-5");

    // The models mirror advertises routekit/-namespaced ids that never start
    // with claude- or gemini- (Cursor's BYOK provider-selection prefixes).
    const models = await fetch(`${gateway.url()}/v1/cursor/models`);
    assert.equal(models.status, 200);
    const ids = ((await models.json()) as { data: Array<{ id: string }> }).data.map(
      (model) => model.id
    );
    assert.deepEqual(ids, [
      "routekit/claude-code/claude-fable-5",
      "routekit/openai/gpt-4o",
      "routekit/openai/gpt-4o:low",
      "routekit/openai/gpt-4o:high",
      "routekit/gemini-proxy/gemini-zzz-9"
    ]);
    for (const id of ids) {
      assert.equal(id.startsWith("claude-"), false, id);
      assert.equal(id.startsWith("gemini-"), false, id);
    }
  } finally {
    await gateway.close();
  }
});
