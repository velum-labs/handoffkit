import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  BackendRequestOptions,
  DiscoveredModel,
  ProviderId,
  ProviderSource
} from "../index.js";
import {
  CatalogBackend,
  parseDiscoveredModels,
  parseRouterConfig,
  UnknownModelError
} from "../index.js";

function fakeSource(
  sourceId: ProviderId,
  models: readonly DiscoveredModel[],
  calls: Array<{ source: string; model?: string }> = []
): ProviderSource {
  return {
    sourceId,
    async discoverModels() {
      return models;
    },
    async chat(body: unknown, _signal?: AbortSignal, _options?: BackendRequestOptions) {
      const model =
        typeof body === "object" &&
        body !== null &&
        "model" in body &&
        typeof body.model === "string"
          ? body.model
          : undefined;
      calls.push({ source: sourceId, ...(model !== undefined ? { model } : {}) });
      return Response.json({ source: sourceId, model });
    },
    async embeddings() {
      return Response.json({});
    }
  };
}

test("RouterConfig requires explicit providers and namespaced defaults", () => {
  const config = parseRouterConfig({
    providers: {
      openai: {},
      codex: { strategy: "round_robin", switchThreshold: 0.8 }
    },
    defaultModel: "codex/gpt-5.5"
  });
  assert.equal(config.providers.openai?.strategy, "capacity_weighted");
  assert.equal(config.providers.codex?.strategy, "round_robin");
  assert.throws(
    () =>
      parseRouterConfig({
        providers: { openai: {} },
        defaultModel: "gpt-5.5"
      }),
    /provider\/model namespace/
  );
  assert.throws(
    () =>
      parseRouterConfig({
        providers: { openai: {} },
        defaultModel: "codex/gpt-5.5"
      }),
    /provider "codex" is not configured/
  );
  assert.throws(
    () => parseRouterConfig({ endpoints: [] }),
    /invalid input|unrecognized key/i
  );
});
test("discovery normalizes native response shapes", () => {
  assert.deepEqual(
    parseDiscoveredModels("openai", {
      data: [{ id: "gpt-5.5" }, { id: "gpt-5.5" }, { nope: true }]
    }).map((model) => model.id),
    ["gpt-5.5"]
  );
  assert.deepEqual(
    parseDiscoveredModels("anthropic", {
      data: [{ id: "claude-opus-4-1" }]
    }).map((model) => model.id),
    ["claude-opus-4-1"]
  );
  assert.deepEqual(
    parseDiscoveredModels("google", {
      models: [{ name: "models/gemini-2.5-pro" }]
    }).map((model) => model.id),
    ["gemini-2.5-pro"]
  );
  assert.deepEqual(
    parseDiscoveredModels("codex", {
      models: [{ slug: "gpt-5.5" }]
    }).map((model) => model.id),
    ["gpt-5.5"]
  );
  assert.throws(
    () => parseDiscoveredModels("openai", { data: [] }),
    /no usable openai models/
  );
});
test("catalog namespaces live models and strips the source before dispatch", async () => {
  const calls: Array<{ source: string; model?: string }> = [];
  const backend = await CatalogBackend.create({
    config: {
      providers: { openai: {}, openrouter: {} },
      defaultModel: "openrouter/moonshotai/kimi-k2-thinking"
    },
    sources: {
      openai: fakeSource("openai", [{ id: "gpt-5.5" }], calls),
      openrouter: fakeSource(
        "openrouter",
        [{ id: "moonshotai/kimi-k2-thinking" }],
        calls
      )
    }
  });

  assert.deepEqual(backend.listModelIds(), [
    "openai/gpt-5.5",
    "openrouter/moonshotai/kimi-k2-thinking"
  ]);
  assert.deepEqual(backend.resolveModelRoute("gpt-5.5", "openai"), {
    publicId: "openai/gpt-5.5",
    nativeId: "gpt-5.5",
    provider: "openai"
  });
  assert.equal(
    backend.resolveModelRoute("gpt-5.5"),
    undefined,
    "bare ids remain invalid without a native-provider scope"
  );
  assert.deepEqual(
    backend.resolveModelRoute(
      "openrouter/moonshotai/kimi-k2-thinking",
      "openai"
    ),
    {
      publicId: "openrouter/moonshotai/kimi-k2-thinking",
      nativeId: "moonshotai/kimi-k2-thinking",
      provider: "openrouter"
    },
    "an exact canonical id wins even on a native client door"
  );
  await backend.chat({ messages: [] });
  await backend.chat({ model: "openai/gpt-5.5", messages: [] });
  assert.deepEqual(calls, [
    { source: "openrouter", model: "moonshotai/kimi-k2-thinking" },
    { source: "openai", model: "gpt-5.5" }
  ]);

  const models = (await (await backend.models()).json()) as {
    data: Array<{ id: string; owned_by: string }>;
  };
  assert.deepEqual(
    models.data.map((model) => [model.id, model.owned_by]),
    [
      ["openai/gpt-5.5", "openai"],
      ["openrouter/moonshotai/kimi-k2-thinking", "openrouter"]
    ]
  );
});

test("unknown models never fall through to the default source", async () => {
  const backend = await CatalogBackend.create({
    config: { providers: { openai: {} } },
    sources: { openai: fakeSource("openai", [{ id: "gpt-5.5" }]) }
  });
  assert.throws(
    () => backend.chat({ model: "openai/not-real", messages: [] }),
    (error: unknown) =>
      error instanceof UnknownModelError && error.model === "openai/not-real"
  );
});

test("startup reports provider-specific discovery and credential failures", async () => {
  await assert.rejects(
    CatalogBackend.create({
      config: { providers: { openai: {} } },
      sources: {
        openai: {
          ...fakeSource("openai", []),
          async discoverModels() {
            throw new Error("bad token");
          }
        }
      }
    }),
    /provider "openai" discovery failed: bad token/
  );
  await assert.rejects(
    CatalogBackend.create({
      config: { providers: { openai: {} } },
      env: {}
    }),
    /provider "openai" is missing credential environment variable OPENAI_API_KEY/
  );
  await assert.rejects(
    CatalogBackend.create({
      config: { providers: { codex: {} } }
    }),
    /provider "codex" requires enrolled subscription accounts/
  );
});
