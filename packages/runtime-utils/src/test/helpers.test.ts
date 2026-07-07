import assert from "node:assert/strict";
import { test } from "node:test";

import { estimateTokens, randomId } from "../index.js";

test("randomId returns hex ids with optional prefix and default length", () => {
  const bare = randomId();
  assert.match(bare, /^[0-9a-f]{10}$/);
  const prefixed = randomId(12, "req_");
  assert.match(prefixed, /^req_[0-9a-f]{12}$/);
});

test("ids minted in the same millisecond stay distinct (panel-root collision guard)", () => {
  // Panel run ids are `panels_${Date.now()}_${randomId(6)}`; the random suffix
  // is the only thing separating two panels started in the same tick, so it
  // must actually be random per call (not seeded by the clock).
  const first = randomId(6);
  const second = randomId(6);
  assert.notEqual(first, second, "back-to-back ids in one tick differ");
});

test("estimateTokens uses ceil(chars/4) with a minimum of 1", () => {
  assert.equal(estimateTokens(""), 1);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokens("user", '{"tool":"payload"}'), 6);
});
