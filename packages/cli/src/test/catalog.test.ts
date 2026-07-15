import assert from "node:assert/strict";
import { test } from "node:test";

import {
  listModelsForAuth,
  parseAnthropicModels,
  parseGoogleModels,
  parseOpenAiModels
} from "../fusion/catalog.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function ids(result: { models: Array<{ id: string }> }): string[] {
  return result.models.map((model) => model.id);
}

// --- parsers ---------------------------------------------------------------

test("parseOpenAiModels keeps chat models and drops non-chat families", () => {
  const parsed = parseOpenAiModels({
    data: [{ id: "gpt-5.5" }, { id: "o4-mini" }, { id: "whisper-1" }, { id: "text-embedding-3-large" }]
  });
  assert.ok(parsed.includes("gpt-5.5"));
  assert.ok(parsed.includes("o4-mini"));
  assert.ok(!parsed.includes("whisper-1"));
  assert.ok(!parsed.includes("text-embedding-3-large"));
});

test("parseAnthropicModels returns all model ids", () => {
  const parsed = parseAnthropicModels({ data: [{ id: "claude-sonnet-4-5" }, { id: "claude-opus-4-8" }] });
  assert.deepEqual(parsed, ["claude-sonnet-4-5", "claude-opus-4-8"]);
});

test("parseGoogleModels strips the models/ prefix and requires generateContent", () => {
  const parsed = parseGoogleModels({
    models: [
      { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] }
    ]
  });
  assert.deepEqual(parsed, ["gemini-2.5-flash"]);
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
  assert.deepEqual(ids(result), ["anthropic/claude-sonnet-4.5", "openai/gpt-5.5"]);
});

test("api-key provider without a key serves the keyless models.dev catalog", async () => {
  const result = await listModelsForAuth("openai", {
    env: {},
    fetchImpl: async (url) => {
      assert.match(String(url), /models\.dev/);
      return jsonResponse({
        openai: {
          models: {
            "gpt-5.5": { id: "gpt-5.5", name: "GPT-5.5", cost: { input: 1.25, output: 10 }, limit: { context: 400000 } }
          }
        }
      });
    }
  });
  assert.equal(result.source, "models.dev");
  assert.deepEqual(ids(result), ["gpt-5.5"]);
  assert.equal(result.models[0]?.pricing, "$1.25/M in · $10/M out");
  assert.equal(result.models[0]?.context, 400000);
});

test("api-key provider without a key falls back to curated when models.dev fails", async () => {
  const result = await listModelsForAuth("openai", {
    env: {},
    fetchImpl: async () => {
      throw new Error("network down");
    }
  });
  assert.equal(result.source, "curated");
  assert.ok(result.models.length > 0);
});

test("api-key provider with a key lists live models", async () => {
  const result = await listModelsForAuth("openai", {
    env: { OPENAI_API_KEY: "sk-test" },
    fetchImpl: async () => jsonResponse({ data: [{ id: "gpt-5.5" }, { id: "text-embedding-3-large" }] })
  });
  assert.equal(result.source, "live");
  assert.ok(ids(result).includes("gpt-5.5"));
  assert.ok(!ids(result).includes("text-embedding-3-large"));
});

test("live lists are enriched with models.dev pricing metadata", async () => {
  const result = await listModelsForAuth("openai", {
    env: { OPENAI_API_KEY: "sk-test" },
    fetchImpl: async (url) => {
      if (String(url).includes("models.dev")) {
        return jsonResponse({
          openai: {
            models: { "gpt-5.5": { id: "gpt-5.5", cost: { input: 1.25, output: 10 }, limit: { context: 400000 } } }
          }
        });
      }
      return jsonResponse({ data: [{ id: "gpt-5.5" }] });
    }
  });
  assert.equal(result.source, "live");
  assert.equal(result.models[0]?.pricing, "$1.25/M in · $10/M out");
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

test("cliproxy with a key lists the proxy's models against its default base URL", async () => {
  const result = await listModelsForAuth("cliproxy", {
    env: { ROUTEKIT_CLIPROXY_API_KEY: "rk-test" },
    fetchImpl: async (url, init) => {
      if (String(url).includes("models.dev")) return jsonResponse({});
      assert.match(String(url), /^http:\/\/127\.0\.0\.1:8317\/v1\/models$/);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer rk-test");
      return jsonResponse({ data: [{ id: "gemini-3.1-pro-preview" }, { id: "kimi-k2.5" }] });
    }
  });
  assert.equal(result.source, "live");
  assert.deepEqual(ids(result), ["gemini-3.1-pro-preview", "kimi-k2.5"]);
});

test("cliproxy honors the ROUTEKIT_CLIPROXY_BASE_URL override for discovery", async () => {
  const result = await listModelsForAuth("cliproxy", {
    env: {
      ROUTEKIT_CLIPROXY_API_KEY: "rk-test",
      ROUTEKIT_CLIPROXY_BASE_URL: "http://127.0.0.1:9999"
    },
    fetchImpl: async (url) => {
      if (String(url).includes("models.dev")) return jsonResponse({});
      assert.match(String(url), /^http:\/\/127\.0\.0\.1:9999\/v1\/models$/);
      return jsonResponse({ data: [{ id: "grok-4.3" }] });
    }
  });
  assert.equal(result.source, "live");
  assert.deepEqual(ids(result), ["grok-4.3"]);
});

test("cliproxy without a key falls back to the curated list", async () => {
  const result = await listModelsForAuth("cliproxy", {
    env: {},
    fetchImpl: async () => jsonResponse({}) // models.dev knows nothing about a local proxy
  });
  assert.equal(result.source, "curated");
  assert.ok(ids(result).includes("gemini-3.1-pro-preview"));
});

test("live list puts the default model first", async () => {
  const result = await listModelsForAuth("openai", {
    env: { OPENAI_API_KEY: "sk-test" },
    fetchImpl: async () => jsonResponse({ data: [{ id: "gpt-4.1" }, { id: "gpt-5.5" }] })
  });
  assert.equal(ids(result)[0], "gpt-5.5");
});
