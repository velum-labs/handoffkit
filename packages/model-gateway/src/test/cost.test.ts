import assert from "node:assert/strict";
import { test } from "node:test";

import {
  estimateCost,
  lookupPricing,
  meterCall,
  parseUsage,
  parseUsageFromSse
} from "../cost.js";

test("single-call metering normalizes provider usage and registry pricing", () => {
  assert.deepEqual(parseUsage({ input_tokens: 80, output_tokens: 20 }), {
    promptTokens: 80,
    completionTokens: 20,
    totalTokens: 100
  });
  assert.deepEqual(lookupPricing("gpt-5.5"), {
    inputPer1mTokens: 1.25,
    outputPer1mTokens: 10
  });
  assert.deepEqual(
    estimateCost(
      { promptTokens: 1_000_000, completionTokens: 1_000_000 },
      lookupPricing("gpt-5.5")
    ),
    { costUsd: 11.25, partialUsage: false }
  );
});

test("SSE usage extraction retains the last provider usage block", () => {
  const text =
    `data: ${JSON.stringify({ choices: [{ delta: { content: "first" } }] })}\n\n` +
    `data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    })}\n\n` +
    "data: [DONE]\n\n";
  assert.deepEqual(parseUsageFromSse(text), {
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15
  });
});

test("SSE usage extraction reads nested Responses completion usage", () => {
  const text =
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 30,
          output_tokens: 12,
          total_tokens: 42
        }
      }
    })}\n\n` +
    "data: [DONE]\n\n";
  assert.deepEqual(parseUsageFromSse(text), {
    promptTokens: 30,
    completionTokens: 12,
    totalTokens: 42
  });
});

test("provider-reported cost is canonical over a registry estimate", () => {
  const call = meterCall({
    model: "gpt-5.5",
    usage: { promptTokens: 1000, completionTokens: 1000 },
    providerCost: {
      source: "provider",
      costUsd: 0.0123,
      providerName: "provider"
    }
  });
  assert.equal(call.costUsd, 0.0123);
  assert.equal(call.providerCostUsd, 0.0123);
  assert.equal(call.unknownCost, false);
});
