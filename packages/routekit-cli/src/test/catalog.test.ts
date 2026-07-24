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
