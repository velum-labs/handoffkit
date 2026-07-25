import assert from "node:assert/strict";
import { test } from "node:test";

import { parseDiscoveredModels } from "../provider-source.js";

test("Anthropic discovery projects authoritative effort and thinking capabilities", () => {
  const [model] = parseDiscoveredModels(
    "anthropic",
    {
      data: [
        {
          id: "claude-fable-5",
          capabilities: {
            effort: {
              supported: true,
              low: { supported: true },
              medium: { supported: false },
              high: { supported: true },
              xhigh: null,
              max: { supported: true }
            },
            thinking: {
              supported: true,
              types: {
                adaptive: { supported: true },
                enabled: { supported: true }
              }
            }
          }
        }
      ]
    },
    "claude-code"
  );

  assert.deepEqual(model?.reasoning, {
    status: "supported",
    efforts: [{ id: "low" }, { id: "high" }, { id: "max" }],
    budget: { minTokens: 1_024 },
    adaptive: true,
    wireShape: "anthropic",
    provenance: "provider",
    refreshedAt: model?.reasoning?.refreshedAt
  });
  assert.equal(model?.reasoning?.defaultEffort, undefined);
});

test("Anthropic discovery preserves explicit unsupported and missing capabilities", () => {
  const models = parseDiscoveredModels(
    "anthropic",
    {
      data: [
        {
          id: "claude-no-reasoning",
          capabilities: {
            effort: { supported: false },
            thinking: {
              supported: false,
              types: {
                adaptive: { supported: false },
                enabled: { supported: false }
              }
            }
          }
        },
        { id: "claude-unknown" }
      ]
    },
    "claude-code"
  );

  assert.deepEqual(models[0]?.reasoning, {
    status: "unsupported",
    adaptive: false,
    wireShape: "anthropic",
    provenance: "provider",
    refreshedAt: models[0]?.reasoning?.refreshedAt
  });
  assert.equal(models[1]?.reasoning, undefined);
});
