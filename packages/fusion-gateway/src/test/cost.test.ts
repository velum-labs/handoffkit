import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addTurnCost,
  addLedgerEntry,
  emptySessionCost,
  estimateCost,
  estimateLocalComputeCost,
  formatUsd,
  lookupPricing,
  meterCall,
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

test("lookupPricing resolves exact ids, aliases, and unknown models", () => {
  assert.deepEqual(lookupPricing("gpt-5.5"), { inputPer1mTokens: 1.25, outputPer1mTokens: 10 });
  assert.deepEqual(lookupPricing("gpt-5.5-2026-05"), { inputPer1mTokens: 1.25, outputPer1mTokens: 10 });
  assert.deepEqual(lookupPricing("claude-haiku-4-5"), { inputPer1mTokens: 1, outputPer1mTokens: 5 });
  assert.equal(lookupPricing("totally-new-model-2027"), undefined);
  assert.equal(lookupPricing("claude-haiku-4-5-unknown-suffix"), undefined);
  assert.deepEqual(lookupPricing("mystery-model", { "mystery-model": { inputPer1mTokens: 1, outputPer1mTokens: 2 } }), {
    inputPer1mTokens: 1,
    outputPer1mTokens: 2
  });
});

test("estimateCost computes input+output cost and supports partial usage", () => {
  const full = estimateCost(
    { promptTokens: 1_000_000, completionTokens: 1_000_000 },
    { inputPer1mTokens: 1.25, outputPer1mTokens: 10 }
  );
  assert.equal(full?.costUsd, 11.25);
  assert.equal(full?.partialUsage, false);

  const promptOnly = estimateCost({ promptTokens: 1_000_000 }, { inputPer1mTokens: 1.25, outputPer1mTokens: 10 });
  assert.equal(promptOnly?.costUsd, 1.25);
  assert.equal(promptOnly?.partialUsage, true);

  assert.equal(estimateCost({}, { inputPer1mTokens: 1, outputPer1mTokens: 2 }), undefined);
  assert.equal(estimateCost({ promptTokens: 1, completionTokens: 1 }, undefined), undefined);
});

test("meterTurn flags partial usage when only one token side is present", () => {
  const turn = meterTurn("gpt-5.5", { promptTokens: 1000 });
  assert.equal(turn.partialUsage, true);
  assert.equal(turn.unknownCost, false);
  assert.ok(Math.abs((turn.costUsd ?? 0) - 0.00125) < 1e-9);
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

test("meterCall and addLedgerEntry split provider and local compute dollars", () => {
  const entry = meterCall({
    model: "mlx-community/Qwen3-1.7B-4bit",
    stage: "panel",
    turn: 1,
    usage: { promptTokens: 100, completionTokens: 50 },
    pricing: {
      "mlx-community/Qwen3-1.7B-4bit": { inputPer1mTokens: 0, outputPer1mTokens: 0 }
    },
    localCompute: {
      activeInferenceMs: 10_000,
      usdPerDeviceHour: 0.36,
      estimatedCostUsd: estimateLocalComputeCost({ activeInferenceMs: 10_000, usdPerDeviceHour: 0.36 })
    }
  });
  assert.equal(entry.providerCostUsd, 0);
  assert.ok(Math.abs((entry.localComputeCostUsd ?? 0) - 0.001) < 1e-9);
  assert.equal(entry.costUsd, 0);
  const total = addLedgerEntry(emptySessionCost(), entry);
  assert.equal(total.totalUsd, 0);
  assert.equal(total.providerUsd, 0);
  assert.ok(Math.abs((total.localComputeUsd ?? 0) - 0.001) < 1e-9);
  assert.equal(total.localActiveMs, 10_000);
  assert.equal(total.totalTokens, 150);
});

test("meterCall prefers exact provider cost over configured price estimates", () => {
  const entry = meterCall({
    model: "openrouter/expensive-model",
    stage: "panel",
    usage: { promptTokens: 1000, completionTokens: 1000 },
    pricing: {
      "openrouter/expensive-model": { inputPer1mTokens: 100, outputPer1mTokens: 100 }
    },
    providerCost: {
      source: "provider",
      costUsd: 0.0123,
      generationId: "gen_123",
      providerName: "OpenRouter"
    }
  });

  assert.equal(entry.providerCostUsd, 0.0123);
  assert.equal(entry.costUsd, 0.0123);
  assert.equal(entry.unknownCost, false);
  assert.equal(entry.providerCost?.source, "provider");
  assert.equal(entry.providerCost?.generationId, "gen_123");
});

test("meterCall leaves failed provider lookups unknown unless explicit pricing is configured", () => {
  const failedLookup = meterCall({
    model: "gpt-5.5",
    stage: "judge_synth",
    usage: { promptTokens: 1000, completionTokens: 1000 },
    providerCost: {
      source: "provider",
      generationId: "gen_pending",
      lookupStatus: "not_ready"
    }
  });
  assert.equal(failedLookup.providerCostUsd, undefined);
  assert.equal(failedLookup.unknownCost, true);

  const explicitFallback = meterCall({
    model: "gpt-5.5",
    stage: "judge_synth",
    usage: { promptTokens: 1000, completionTokens: 1000 },
    pricing: {
      "gpt-5.5": { inputPer1mTokens: 1, outputPer1mTokens: 2 }
    },
    providerCost: {
      source: "provider",
      generationId: "gen_pending",
      lookupStatus: "not_ready"
    }
  });
  assert.equal(explicitFallback.providerCostUsd, 0.003);
  assert.equal(explicitFallback.providerCost?.source, "estimate");
  assert.equal(explicitFallback.providerCost?.lookupStatus, "fallback_not_ready");
  assert.equal(explicitFallback.unknownCost, false);
});

test("formatUsd renders compact dollars", () => {
  assert.ok(formatUsd(0.00625).startsWith("$0.006"), "sub-cent amounts keep 4 digits");
  assert.equal(formatUsd(1.5), "$1.50");
  assert.equal(formatUsd(2.5, "EUR"), "2.50 EUR");
});
