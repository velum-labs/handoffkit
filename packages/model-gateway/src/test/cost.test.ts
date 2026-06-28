import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addTurnCost,
  emptySessionCost,
  estimateCost,
  formatUsd,
  lookupPricing,
  meterTurn,
  parseUsage,
  parseUsageFromSse
} from "../cost.js";

test("parseUsage reads OpenAI-shaped usage", () => {
  const usage = parseUsage({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
  assert.deepEqual(usage, { promptTokens: 100, completionTokens: 50, totalTokens: 150 });
});

test("parseUsage reads Anthropic-shaped usage and derives the total", () => {
  const usage = parseUsage({ input_tokens: 80, output_tokens: 20 });
  assert.deepEqual(usage, { promptTokens: 80, completionTokens: 20, totalTokens: 100 });
});

test("parseUsage returns undefined when no token field is present", () => {
  assert.equal(parseUsage({}), undefined);
  assert.equal(parseUsage(null), undefined);
  assert.equal(parseUsage("nope"), undefined);
});

test("parseUsageFromSse extracts the last usage block on the stream", () => {
  const sse =
    `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n` +
    "data: [DONE]\n\n";
  assert.deepEqual(parseUsageFromSse(sse), { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
});

test("lookupPricing matches exact ids and longest prefix; overrides win", () => {
  assert.deepEqual(lookupPricing("gpt-5.5"), { inputPer1mTokens: 1.25, outputPer1mTokens: 10 });
  // A dated id resolves via the gpt-5.5 prefix.
  assert.deepEqual(lookupPricing("gpt-5.5-2026-01-01"), { inputPer1mTokens: 1.25, outputPer1mTokens: 10 });
  // The cheapest recommended judge (claude-haiku-4-5) resolves via the claude-haiku family prefix.
  assert.deepEqual(lookupPricing("claude-haiku-4-5"), { inputPer1mTokens: 1, outputPer1mTokens: 5 });
  // Unknown model → undefined unless overridden.
  assert.equal(lookupPricing("mystery-model"), undefined);
  assert.deepEqual(lookupPricing("mystery-model", { "mystery-model": { inputPer1mTokens: 1, outputPer1mTokens: 2 } }), {
    inputPer1mTokens: 1,
    outputPer1mTokens: 2
  });
});

test("estimateCost computes input+output cost from usage and pricing", () => {
  // 1,000,000 prompt tokens @ $1.25/M + 1,000,000 completion @ $10/M = $11.25.
  const cost = estimateCost(
    { promptTokens: 1_000_000, completionTokens: 1_000_000 },
    { inputPer1mTokens: 1.25, outputPer1mTokens: 10 }
  );
  assert.equal(cost, 11.25);
  // Missing pricing or a token side → undefined (unknown, not zero).
  assert.equal(estimateCost({ promptTokens: 1 }, { inputPer1mTokens: 1, outputPer1mTokens: 2 }), undefined);
  assert.equal(estimateCost({ promptTokens: 1, completionTokens: 1 }, undefined), undefined);
});

test("meterTurn: usage + known pricing yields the expected cost", () => {
  const turn = meterTurn("gpt-5.5", { promptTokens: 1000, completionTokens: 500 });
  // 1000/1e6*1.25 + 500/1e6*10 = 0.00125 + 0.005 = 0.00625
  assert.equal(turn.unknownUsage, false);
  assert.equal(turn.unknownCost, false);
  assert.ok(Math.abs((turn.costUsd ?? 0) - 0.00625) < 1e-9);
});

test("meterTurn clearly marks unknown usage and unknown pricing", () => {
  const noUsage = meterTurn("gpt-5.5", undefined);
  assert.equal(noUsage.unknownUsage, true);
  assert.equal(noUsage.unknownCost, true);
  assert.equal(noUsage.costUsd, undefined);

  const noPrice = meterTurn("fusion-panel", { promptTokens: 10, completionTokens: 10 });
  assert.equal(noPrice.unknownUsage, false);
  assert.equal(noPrice.unknownCost, true, "no price for fusion-panel → cost unknown, tokens still counted");
  assert.equal(noPrice.usage.promptTokens, 10);
});

test("addTurnCost accumulates a running session total and counts unknown turns", () => {
  let total = emptySessionCost();
  total = addTurnCost(total, meterTurn("gpt-5.5", { promptTokens: 1000, completionTokens: 500 }));
  total = addTurnCost(total, meterTurn("gpt-5.5", { promptTokens: 2000, completionTokens: 1000 }));
  total = addTurnCost(total, meterTurn("fusion-panel", { promptTokens: 10, completionTokens: 10 }));
  assert.ok(Math.abs(total.totalUsd - (0.00625 + 0.0125)) < 1e-9);
  assert.equal(total.promptTokens, 3010);
  assert.equal(total.completionTokens, 1510);
  assert.equal(total.meteredTurns, 2);
  assert.equal(total.unknownCostTurns, 1);
});

test("formatUsd renders compact dollars", () => {
  assert.ok(formatUsd(0.00625).startsWith("$0.006"), "sub-cent amounts keep 4 digits");
  assert.equal(formatUsd(1.5), "$1.50");
  assert.equal(formatUsd(2.5, "EUR"), "2.50 EUR");
});
