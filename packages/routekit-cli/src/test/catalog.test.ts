import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchLiveCatalog } from "../catalog.js";

const models = [
  { id: "openai/text-embedding-ada-002", capabilities: {} },
  { id: "openai/gpt-5.5", capabilities: { streaming: "supported" } }
];

test("external catalog uses the gateway's advertised default model", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      object: "list",
      default_model: "openai/gpt-5.5",
      data: models
    });
  try {
    const catalog = await fetchLiveCatalog("https://gateway.test");
    assert.equal(catalog.defaultModel, "openai/gpt-5.5");
  } finally {
    globalThis.fetch = original;
  }
});

test("the gateway default overrides a local fallback model", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      object: "list",
      default_model: "openai/gpt-5.5",
      data: models
    });
  try {
    const catalog = await fetchLiveCatalog("https://gateway.test", {
      defaultModel: "openai/text-embedding-ada-002"
    });
    assert.equal(catalog.defaultModel, "openai/gpt-5.5");
  } finally {
    globalThis.fetch = original;
  }
});

test("external catalog preserves billing metadata and picker labels", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      object: "list",
      default_model: "anthropic/claude-sonnet-4-5",
      data: [
        {
          id: "anthropic/claude-sonnet-4-5",
          owned_by: "anthropic",
          accountClass: "api-key",
          billingMode: "metered-api",
          displayLabel: "Claude Sonnet 4.5 · Anthropic API",
          capabilities: {}
        },
        {
          id: "claude-code/claude-sonnet-4-5",
          owned_by: "claude-code",
          accountClass: "subscription",
          billingMode: "subscription",
          display_name: "Claude Sonnet 4.5 · Claude Max",
          capabilities: {}
        }
      ]
    });
  try {
    const catalog = await fetchLiveCatalog("https://gateway.test");
    assert.equal(
      catalog.models[0]?.displayLabel,
      "Claude Sonnet 4.5 · Anthropic API"
    );
    assert.equal(catalog.models[1]?.billingMode, "subscription");
    assert.equal(
      catalog.models[1]?.displayLabel,
      "Claude Sonnet 4.5 · Claude Max"
    );
  } finally {
    globalThis.fetch = original;
  }
});
