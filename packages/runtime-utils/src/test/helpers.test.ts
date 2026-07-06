import assert from "node:assert/strict";
import { test } from "node:test";

import { estimateTokens, randomId } from "../index.js";

test("randomId returns hex ids with optional prefix and default length", () => {
  const bare = randomId();
  assert.match(bare, /^[0-9a-f]{10}$/);
  const prefixed = randomId(12, "req_");
  assert.match(prefixed, /^req_[0-9a-f]{12}$/);
});

test("estimateTokens uses ceil(chars/4) with a minimum of 1", () => {
  assert.equal(estimateTokens(""), 1);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokens("user", '{"tool":"payload"}'), 6);
});
