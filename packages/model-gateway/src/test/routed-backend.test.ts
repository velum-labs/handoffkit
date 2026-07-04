import assert from "node:assert/strict";
import { test } from "node:test";

import { ModelRoutedBackend, parsePanelDepth } from "../backend.js";
import type { Backend } from "../backend.js";

function stubBackend(id: string, defaultModel?: string): Backend & { chats: unknown[] } {
  const chats: unknown[] = [];
  return {
    defaultModel,
    chats,
    chat(body: unknown) {
      chats.push(body);
      return Promise.resolve(
        new Response(JSON.stringify({ served_by: id }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
    },
    models: () => Promise.resolve(new Response("{}", { status: 200 })),
    embeddings: () => Promise.resolve(new Response("{}", { status: 200 }))
  };
}

test("ModelRoutedBackend dispatches by requested model id", async () => {
  const primary = stubBackend("primary", "qwen3");
  const routed = stubBackend("front-door");
  const backend = new ModelRoutedBackend({
    routedModelIds: ["fusion-panel", "fusion-kimi"],
    routed,
    primary
  });

  const member = (await (await backend.chat({ model: "qwen3", messages: [] })).json()) as { served_by: string };
  assert.equal(member.served_by, "primary");
  const fused = (await (await backend.chat({ model: "fusion-kimi", messages: [] })).json()) as { served_by: string };
  assert.equal(fused.served_by, "front-door");
  // No model at all falls back to the primary (its defaultModel applies).
  const bare = (await (await backend.chat({ messages: [] })).json()) as { served_by: string };
  assert.equal(bare.served_by, "primary");

  assert.equal(backend.defaultModel, "qwen3");
  assert.deepEqual([...backend.listModelIds()], ["qwen3", "fusion-panel", "fusion-kimi"]);
  assert.equal(backend.resolveModel("fusion-panel"), "fusion-panel");
  assert.equal(backend.resolveModel("anything-else"), "qwen3");
});

test("parsePanelDepth: absent/invalid means depth 0, positive integers pass", () => {
  assert.equal(parsePanelDepth(undefined), 0);
  assert.equal(parsePanelDepth(""), 0);
  assert.equal(parsePanelDepth("nope"), 0);
  assert.equal(parsePanelDepth("-3"), 0);
  assert.equal(parsePanelDepth("1"), 1);
  assert.equal(parsePanelDepth("2"), 2);
  assert.equal(parsePanelDepth(["3", "9"]), 3);
});
