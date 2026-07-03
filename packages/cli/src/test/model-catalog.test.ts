import assert from "node:assert/strict";
import { test } from "node:test";

import {
  listModelsForAuth,
  parseAnthropicModels,
  parseGoogleModels,
  parseOpenAiModels
} from "../fusion/model-catalog.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

// --- parsers ---------------------------------------------------------------

test("parseOpenAiModels keeps chat models and drops non-chat families", () => {
  const ids = parseOpenAiModels({
    data: [{ id: "gpt-5.5" }, { id: "o4-mini" }, { id: "whisper-1" }, { id: "text-embedding-3-large" }]
  });
  assert.ok(ids.includes("gpt-5.5"));
  assert.ok(ids.includes("o4-mini"));
  assert.ok(!ids.includes("whisper-1"));
  assert.ok(!ids.includes("text-embedding-3-large"));
});

test("parseAnthropicModels returns all model ids", () => {
  const ids = parseAnthropicModels({ data: [{ id: "claude-sonnet-4-5" }, { id: "claude-opus-4-8" }] });
  assert.deepEqual(ids, ["claude-sonnet-4-5", "claude-opus-4-8"]);
});

test("parseGoogleModels strips the models/ prefix and requires generateContent", () => {
  const ids = parseGoogleModels({
    models: [
      { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] }
    ]
  });
  assert.deepEqual(ids, ["gemini-2.5-flash"]);
});

test("parsers tolerate malformed payloads", () => {
  assert.deepEqual(parseOpenAiModels(null), []);
  assert.deepEqual(parseAnthropicModels({}), []);
  assert.deepEqual(parseGoogleModels({ models: "nope" }), []);
});

// --- listModelsForAuth -----------------------------------------------------

test("subscriptions, local, and default-curated providers use the curated list", async () => {
  for (const choice of ["claude-code", "codex", "local", "openrouter"] as const) {
    const result = await listModelsForAuth(choice, {
      env: { OPENROUTER_API_KEY: "sk-or-test" },
      fetchImpl: () => assert.fail("no fetch")
    });
    assert.equal(result.source, "curated");
    assert.ok(result.models.length > 0);
  }
});

test("openrouter can opt into live discovery from provider metadata", async () => {
  const result = await listModelsForAuth("openrouter", {
    env: { OPENROUTER_API_KEY: "sk-or-test" },
    liveDiscovery: true,
    fetchImpl: async () =>
      jsonResponse({
        data: [{ id: "anthropic/claude-sonnet-4.5" }, { id: "openai/gpt-5.5" }]
      })
  });
  assert.equal(result.source, "live");
  assert.deepEqual(result.models, ["anthropic/claude-sonnet-4.5", "openai/gpt-5.5"]);
});

test("api-key provider without a key falls back to curated (no fetch)", async () => {
  const result = await listModelsForAuth("openai", { env: {}, fetchImpl: () => assert.fail("no fetch") });
  assert.equal(result.source, "curated");
});

test("api-key provider with a key lists live models", async () => {
  const result = await listModelsForAuth("openai", {
    env: { OPENAI_API_KEY: "sk-test" },
    fetchImpl: async () => jsonResponse({ data: [{ id: "gpt-5.5" }, { id: "text-embedding-3-large" }] })
  });
  assert.equal(result.source, "live");
  assert.ok(result.models.includes("gpt-5.5"));
  assert.ok(!result.models.includes("text-embedding-3-large"));
});

test("api-key provider falls back to curated when discovery fails", async () => {
  const result = await listModelsForAuth("anthropic", {
    env: { ANTHROPIC_API_KEY: "sk-test" },
    fetchImpl: async () => {
      throw new Error("network down");
    }
  });
  assert.equal(result.source, "curated");
  assert.ok(result.models.length > 0);
});

test("live list puts the default model first", async () => {
  const result = await listModelsForAuth("openai", {
    env: { OPENAI_API_KEY: "sk-test" },
    fetchImpl: async () => jsonResponse({ data: [{ id: "gpt-4.1" }, { id: "gpt-5.5" }] })
  });
  assert.equal(result.models[0], "gpt-5.5");
});
