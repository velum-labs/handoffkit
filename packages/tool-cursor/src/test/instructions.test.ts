import assert from "node:assert/strict";
import { test } from "node:test";

import { cursorModelName } from "@velum-labs/routekit-contracts";

import { cursorInstructions } from "../launch.js";

test("cursorInstructions print the gateway's routekit/-namespaced spelling", () => {
  const model = "claude-code/claude-fable-5";
  const text = cursorInstructions("https://example.ts.net", model, "token");
  assert.match(text, /Override OpenAI Base URL : https:\/\/example\.ts\.net\/v1\/cursor/);
  assert.match(text, new RegExp(`Model name\\s+: ${cursorModelName(model)}`));
  assert.doesNotMatch(text, /claude-code-claude-fable-5/);
  assert.match(text, /namespaced under routekit\//);
});
