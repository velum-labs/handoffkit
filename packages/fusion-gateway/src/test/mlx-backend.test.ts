import assert from "node:assert/strict";
import { test } from "node:test";

import { withThinkingDefault } from "../mlx-backend.js";

test("withThinkingDefault: injects enable_thinking when chat_template_kwargs is absent", () => {
  const body = { model: "qwen3", messages: [{ role: "user", content: "hi" }] };
  const out = withThinkingDefault(body) as Record<string, unknown>;
  assert.deepEqual(out.chat_template_kwargs, { enable_thinking: true });
  assert.equal(out.model, "qwen3");
  // The caller's body is never mutated.
  assert.equal("chat_template_kwargs" in body, false);
});

test("withThinkingDefault: an explicit chat_template_kwargs always wins", () => {
  const off = { model: "qwen3", chat_template_kwargs: { enable_thinking: false } };
  assert.equal(withThinkingDefault(off), off);

  const custom = { model: "qwen3", chat_template_kwargs: { foo: "bar" } };
  assert.equal(withThinkingDefault(custom), custom);
});

test("withThinkingDefault: non-object bodies pass through untouched", () => {
  for (const body of [undefined, null, "raw", 7, ["a"]]) {
    assert.equal(withThinkingDefault(body), body);
  }
});
