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
  assert.throws(
    () =>
      parseRouterConfig({
        providers: { openai: {} },
        reasoningCapabilities: {
          "openai/opaque": {
            efforts: [{ id: "quick" }],
            defaultEffort: "missing"
          }
        }
      }),
    /default reasoning effort/
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
      models: [
        {
          slug: "gpt-5.5",
          default_reasoning_level: "balanced",
          supported_reasoning_levels: [
            { effort: "quick", description: "Quick" },
            { effort: "balanced", description: "Balanced" }
          ]
        }
      ]
    }, "codex").map((model) => model.id),
    ["gpt-5.5"]
  );
  const reasoning = parseDiscoveredModels(
    "codex",
    {
      models: [
        {
          slug: "opaque",
          default_reasoning_level: "balanced",
          supported_reasoning_levels: ["quick", "balanced"]
        }
      ]
    },
    "codex"
  )[0]?.reasoning;
  assert.deepEqual(reasoning?.efforts, [{ id: "quick" }, { id: "balanced" }]);
  assert.equal(reasoning?.defaultEffort, "balanced");
  assert.equal(reasoning?.wireShape, "openai-responses");
  assert.equal(reasoning?.provenance, "provider");
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

test("catalog applies configured opaque efforts and rejects unavailable values before egress", async () => {
  const calls: Array<{ source: string; model?: string }> = [];
  const backend = await CatalogBackend.create({
    config: {
      providers: { openai: {} },
      defaultModel: "openai/opaque",
      reasoningCapabilities: {
        "openai/opaque": {
          efforts: [
            { id: "balanced", aliases: ["cursor-balanced"] },
            { id: "deep" }
          ],
          defaultEffort: "balanced",
          wireShape: "openai-chat"
        }
      }
    },
    sources: {
      openai: fakeSource("openai", [{ id: "opaque" }], calls)
    }
  });
  const accepted = await backend.chat({
    model: "openai/opaque",
    reasoning_effort: "cursor-balanced",
    messages: []
  });
  assert.equal(accepted.status, 200);
  const rejected = await backend.chat({
    model: "openai/opaque",
    reasoning_effort: "maximum",
    messages: []
  });
  assert.equal(rejected.status, 400);
  const malformed = await backend.chat({
    model: "openai/opaque",
    reasoning_effort: 7,
    messages: []
  });
  assert.equal(malformed.status, 400);
  assert.equal(calls.length, 1);
  assert.equal(
    backend.reasoningCapabilities("openai/opaque")?.provenance,
    "config"
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
