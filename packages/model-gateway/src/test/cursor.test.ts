import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cursorModelAliasId,
  isCursorChatBody,
  resolveCursorModelAlias,
  translateCursorRequest
} from "../adapters/cursor.js";
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

test("Cursor model aliases respell namespaced ids with dashes", () => {
  assert.equal(cursorModelAliasId("claude-code/claude-fable-5"), "claude-code-claude-fable-5");
  assert.equal(cursorModelAliasId("openai/gpt-4o"), "openai-gpt-4o");
  assert.equal(cursorModelAliasId("route-primary"), "route-primary");
  assert.equal(
    cursorModelAliasId("openrouter/moonshotai/kimi-k2-thinking"),
    "openrouter-moonshotai-kimi-k2-thinking",
    "every slash is respelled, not just the namespace separator"
  );

  const served = ["claude-code/claude-fable-5", "openai/gpt-4o", "route-primary"];
  assert.equal(
    resolveCursorModelAlias("openrouter-moonshotai-kimi-k2-thinking", [
      ...served,
      "openrouter/moonshotai/kimi-k2-thinking"
    ]),
    "openrouter/moonshotai/kimi-k2-thinking"
  );
  assert.equal(
    resolveCursorModelAlias("claude-code-claude-fable-5", served),
    "claude-code/claude-fable-5"
  );
  assert.equal(resolveCursorModelAlias("openai-gpt-4o", served), "openai/gpt-4o");
  // Served-as-spelled ids and unknown names never rewrite.
  assert.equal(resolveCursorModelAlias("route-primary", served), undefined);
  assert.equal(resolveCursorModelAlias("claude-fable-5", served), undefined);
  assert.equal(resolveCursorModelAlias(undefined, served), undefined);
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
      ["route-primary"]
    );
  } finally {
    await gateway.close();
  }
});

test("Cursor route resolves dashed model aliases to namespaced ids", async () => {
  let received: { model?: unknown } | undefined;
  const backend: Backend = {
    defaultModel: "claude-code/claude-fable-5",
    chat(body) {
      received = body as { model?: unknown };
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
            { id: "openai/gpt-4o", object: "model" }
          ]
        })
      ),
    listModelIds: () => ["claude-code/claude-fable-5", "openai/gpt-4o"],
    embeddings: () => Promise.resolve(new Response(null, { status: 501 }))
  };
  const gateway = await startGateway({ backend });
  try {
    const response = await fetch(`${gateway.url()}/v1/cursor/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-code-claude-fable-5",
        messages: [{ role: "user", content: "hi" }]
      })
    });
    assert.equal(response.status, 200);
    assert.equal(received?.model, "claude-code/claude-fable-5");

    // The models mirror advertises the dashed spelling Cursor accepts.
    const models = await fetch(`${gateway.url()}/v1/cursor/models`);
    assert.equal(models.status, 200);
    assert.deepEqual(
      ((await models.json()) as { data: Array<{ id: string }> }).data.map((model) => model.id),
      ["claude-code-claude-fable-5", "openai-gpt-4o"]
    );
  } finally {
    await gateway.close();
  }
});
