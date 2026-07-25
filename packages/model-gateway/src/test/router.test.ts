import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  BackendRequestOptions,
  DiscoveredModel,
  ProviderId,
  ProviderSource
} from "../index.js";
import {
  REASONING_SELECTION,
  reasoningSelectionErrorOf,
  reasoningSelectionOf
} from "../adapters/openai-chat-wire.js";
import {
  CatalogBackend,
  NoModelAvailableError,
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

test("RouterConfig accepts explicit provider maps and namespaced defaults", () => {
  assert.deepEqual(parseRouterConfig({ providers: {} }).providers, {});
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

test("empty provider configuration creates a credential-independent empty catalog", async () => {
  const backend = await CatalogBackend.create({
    config: { providers: {} },
    env: {}
  });
  assert.equal(backend.defaultModel, undefined);
  assert.deepEqual(backend.listModelIds(), []);
  assert.deepEqual(await backend.providerStatuses(), []);
  assert.deepEqual(await (await backend.models()).json(), {
    object: "list",
    data: []
  });
  assert.throws(
    () => backend.chat({ messages: [] }),
    (error: unknown) => error instanceof NoModelAvailableError
  );
  assert.throws(
    () => backend.chat({ model: "openai/not-configured", messages: [] }),
    (error: unknown) =>
      error instanceof UnknownModelError &&
      error.model === "openai/not-configured"
  );
  assert.throws(
    () => backend.embeddings({ input: "hello" }),
    (error: unknown) => error instanceof NoModelAvailableError
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
    provider: "openai",
    reasoning: backend.reasoningCapabilities("openai/gpt-5.5")
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
  assert.deepEqual(backend.modelInfo("openai/gpt-5.5"), {
    id: "openai/gpt-5.5",
    provider: "openai",
    nativeModel: "gpt-5.5",
    accountClass: "api-key",
    billingMode: "metered-api",
    default: false,
    capabilities: {},
    reasoning: {
      status: "supported",
      efforts: ["none", "low", "medium", "high", "xhigh"].map((id) => ({ id })),
      wireShape: "openai-chat",
      provenance: "builtin"
    }
  });
  assert.equal(backend.modelInfo("openai/not-real"), undefined);
});

test("catalog infers verified OpenAI gpt-5.5 reasoning controls and honors precedence", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const backend = await CatalogBackend.create({
    config: { providers: { openai: {} }, defaultModel: "openai/gpt-5.5" },
    sources: {
      openai: {
        ...fakeSource("openai", [{ id: "gpt-5.5" }]),
        async chat(body: unknown) {
          bodies.push(body as Record<string, unknown>);
          return Response.json({});
        }
      }
    }
  });
  assert.deepEqual(
    backend.reasoningCapabilities("openai/gpt-5.5")?.efforts?.map((effort) => effort.id),
    ["none", "low", "medium", "high", "xhigh"]
  );
  assert.equal(backend.reasoningCapabilities("openai/gpt-5.5")?.provenance, "builtin");
  const models = (await (await backend.models()).json()) as {
    data: Array<{ reasoning?: { efforts?: Array<{ id: string }> } }>;
  };
  assert.deepEqual(models.data[0]?.reasoning?.efforts?.map((effort) => effort.id), [
    "none", "low", "medium", "high", "xhigh"
  ]);
  for (const effort of ["none", "low", "medium", "high", "xhigh"]) {
    assert.equal(
      (await backend.chat({ model: "openai/gpt-5.5", reasoning_effort: effort, messages: [] })).status,
      200
    );
  }
  for (const effort of ["minimal", "max"]) {
    assert.equal(
      (await backend.chat({ model: "openai/gpt-5.5", reasoning_effort: effort, messages: [] })).status,
      400
    );
  }
  assert.deepEqual(bodies.map((body) => body.reasoning_effort), [
    "none", "low", "medium", "high", "xhigh"
  ]);

  const providerMetadata = await CatalogBackend.create({
    config: { providers: { openai: {} } },
    sources: {
      openai: fakeSource("openai", [{
        id: "gpt-5.5",
        reasoning: { status: "supported", efforts: [{ id: "provider-only" }], provenance: "provider" }
      }])
    }
  });
  assert.deepEqual(providerMetadata.reasoningCapabilities("openai/gpt-5.5")?.efforts, [
    { id: "provider-only" }
  ]);
});

test("configured model aliases serve namespaced models under slash-free names", async () => {
  const calls: Array<{ source: string; model?: string }> = [];
  const backend = await CatalogBackend.create({
    config: {
      providers: { "claude-code": {} },
      modelAliases: { "velum-fable-5": "claude-code/claude-fable-5" }
    },
    sources: {
      "claude-code": fakeSource(
        "claude-code",
        [{ id: "claude-fable-5" }],
        calls
      )
    }
  });

  assert.deepEqual(backend.listModelIds(), [
    "claude-code/claude-fable-5",
    "velum-fable-5"
  ]);
  assert.equal(backend.servesModel("velum-fable-5"), true);
  assert.deepEqual(backend.resolveModelRoute("velum-fable-5"), {
    publicId: "velum-fable-5",
    nativeId: "claude-fable-5",
    provider: "claude-code"
  });
  assert.equal(backend.modelInfo("velum-fable-5")?.id, "velum-fable-5");
  assert.equal(
    backend.modelInfo("velum-fable-5")?.nativeModel,
    "claude-fable-5"
  );
  await backend.chat({ model: "velum-fable-5", messages: [] });
  assert.deepEqual(calls, [
    { source: "claude-code", model: "claude-fable-5" }
  ]);
});

test("model aliases reject bad shapes and unknown targets", async () => {
  assert.throws(
    () =>
      parseRouterConfig({
        providers: { openai: {} },
        modelAliases: { "bad/alias": "openai/gpt-5.5" }
      }),
    /must not contain "\/"/
  );
  assert.throws(
    () =>
      parseRouterConfig({
        providers: { openai: {} },
        modelAliases: { "velum-fable-5": "claude-code/claude-fable-5" }
      }),
    /provider "claude-code" is not configured/
  );
  await assert.rejects(
    CatalogBackend.create({
      config: {
        providers: { openai: {} },
        modelAliases: { "velum-gpt": "openai/not-discovered" }
      },
      sources: { openai: fakeSource("openai", [{ id: "gpt-5.5" }]) }
    }),
    /targets "openai\/not-discovered", which no configured provider serves/
  );
  await assert.rejects(
    CatalogBackend.create({
      config: {
        providers: { openai: {} },
        modelAliases: { "openai/gpt-5.5": "openai/gpt-5.5" }
      },
      sources: { openai: fakeSource("openai", [{ id: "gpt-5.5" }]) }
    }),
    /must not contain "\/"/
  );
});

test("model info exhaustively classifies subscription and proxy billing", async () => {
  const backend = await CatalogBackend.create({
    config: {
      providers: { codex: {}, "claude-code": {}, cliproxy: {} },
      defaultModel: "codex/gpt-5.5"
    },
    sources: {
      codex: fakeSource("codex", [
        {
          id: "gpt-5.5",
          capabilities: { tools: "supported" },
          reasoning: {
            status: "supported",
            efforts: [{ id: "high" }],
            provenance: "provider",
            refreshedAt: "2026-07-22T00:00:00.000Z"
          }
        }
      ]),
      "claude-code": fakeSource("claude-code", [{ id: "claude-opus-4-1" }]),
      cliproxy: fakeSource("cliproxy", [{ id: "local-route" }])
    }
  });
  assert.deepEqual(backend.modelInfo("codex/gpt-5.5"), {
    id: "codex/gpt-5.5",
    provider: "codex",
    nativeModel: "gpt-5.5",
    accountClass: "subscription",
    billingMode: "subscription",
    default: true,
    capabilities: { tools: "supported" },
    reasoning: {
      status: "supported",
      efforts: [{ id: "high" }],
      provenance: "provider",
      refreshedAt: "2026-07-22T00:00:00.000Z"
    }
  });
  assert.deepEqual(
    {
      accountClass: backend.modelInfo("claude-code/claude-opus-4-1")?.accountClass,
      billingMode: backend.modelInfo("claude-code/claude-opus-4-1")?.billingMode
    },
    { accountClass: "subscription", billingMode: "subscription" }
  );
  assert.deepEqual(
    {
      accountClass: backend.modelInfo("cliproxy/local-route")?.accountClass,
      billingMode: backend.modelInfo("cliproxy/local-route")?.billingMode
    },
    { accountClass: "proxy", billingMode: "upstream-managed" }
  );
  await backend.close();
});

test("cliproxy routes are attributed as subscription billing", async () => {
  const backend = await CatalogBackend.create({
    config: {
      providers: { cliproxy: {} },
      defaultModel: "cliproxy/gpt-test"
    },
    sources: {
      cliproxy: fakeSource("cliproxy", [{ id: "gpt-test" }])
    }
  });
  const updates: unknown[] = [];
  const response = await backend.chat(
    { model: "cliproxy/gpt-test", messages: [] },
    undefined,
    { onAttribution: (update) => updates.push(update) }
  );
  assert.equal(response.status, 200);
  assert.deepEqual(updates, [
    {
      effective_model: "cliproxy/gpt-test",
      native_model: "gpt-test",
      provider: "cliproxy",
      billing_mode: "subscription"
    }
  ]);
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

test("catalog treats Codex none as disabled only for models without reasoning controls", async () => {
  const exercise = async (
    reasoning: DiscoveredModel["reasoning"],
    effort: string
  ): Promise<{ response: Response; bodies: Array<Record<string, unknown>> }> => {
    const bodies: Array<Record<string, unknown>> = [];
    const backend = await CatalogBackend.create({
      config: {
        providers: { openai: {} },
        defaultModel: "openai/model"
      },
      sources: {
        openai: {
          sourceId: "openai",
          async discoverModels() {
            return [{ id: "model", ...(reasoning !== undefined ? { reasoning } : {}) }];
          },
          async chat(body: unknown) {
            bodies.push(body as Record<string, unknown>);
            return Response.json({});
          },
          async embeddings() {
            return Response.json({});
          }
        }
      }
    });
    return {
      response: await backend.chat({
        model: "openai/model",
        reasoning_effort: effort,
        messages: []
      }),
      bodies
    };
  };

  for (const reasoning of [
    undefined,
    { status: "unknown", provenance: "unknown" } as const,
    { status: "unsupported", provenance: "provider" } as const
  ]) {
    const normalized = await exercise(reasoning, "none");
    assert.equal(normalized.response.status, 200);
    assert.equal(normalized.bodies.length, 1);
    assert.equal(normalized.bodies[0]?.reasoning_effort, undefined);
  }

  const undiscoveredEffort = await exercise(undefined, "medium");
  assert.equal(undiscoveredEffort.response.status, 400);
  assert.equal(undiscoveredEffort.bodies.length, 0);

  const advertisedNone = await exercise(
    {
      status: "supported",
      efforts: [{ id: "none" }, { id: "high" }],
      provenance: "provider"
    },
    "none"
  );
  assert.equal(advertisedNone.response.status, 200);
  assert.equal(advertisedNone.bodies[0]?.reasoning_effort, "none");

  const unsupportedNone = await exercise(
    {
      status: "supported",
      efforts: [{ id: "low" }, { id: "high" }],
      provenance: "provider"
    },
    "none"
  );
  assert.equal(unsupportedNone.response.status, 400);
  assert.equal(unsupportedNone.bodies.length, 0);
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


test("reasoning selection validation rejects malformed public and internal metadata", async () => {
  const valid = [
    { mode: "auto" },
    { mode: "disabled" },
    { mode: "adaptive" },
    { mode: "effort", effort: "high" },
    { mode: "budget", budgetTokens: 2048 }
  ] as const;
  for (const selection of valid) {
    const body = { x_routekit: { version: 1, selection } };
    assert.equal(reasoningSelectionErrorOf(body), undefined);
    assert.deepEqual(reasoningSelectionOf(body), selection);
  }

  const invalid: Array<[unknown, RegExp]> = [
    [{ mode: "future" }, /mode is unsupported/],
    [{ mode: "effort" }, /effort must be a non-empty string/],
    [{ mode: "effort", effort: "" }, /effort must be a non-empty string/],
    [{ mode: "budget", budgetTokens: 1.5 }, /budgetTokens must be a positive integer/],
    [{ mode: "budget", budgetTokens: 0 }, /budgetTokens must be a positive integer/],
    [[{ mode: "auto" }], /must be an object/]
  ];
  for (const [selection, expected] of invalid) {
    const publicBody = { x_routekit: { version: 1, selection } };
    assert.match(reasoningSelectionErrorOf(publicBody) ?? "", expected);
    assert.deepEqual(reasoningSelectionOf(publicBody), { mode: "auto" });
    const internalBody: Record<PropertyKey, unknown> = {};
    Object.defineProperty(internalBody, REASONING_SELECTION, {
      value: selection,
      enumerable: true
    });
    assert.match(reasoningSelectionErrorOf(internalBody) ?? "", expected);
    assert.deepEqual(reasoningSelectionOf(internalBody), { mode: "auto" });
  }
  assert.equal(reasoningSelectionErrorOf({ x_routekit: [] }), "x_routekit must be an object");
  assert.deepEqual(reasoningSelectionOf({ x_routekit: [] }), { mode: "auto" });

  const calls: Array<{ source: string; model?: string }> = [];
  const backend = await CatalogBackend.create({
    config: {
      providers: { openai: {} },
      defaultModel: "openai/opaque",
      reasoningCapabilities: {
        "openai/opaque": {
          efforts: [{ id: "high" }],
          budget: { minTokens: 1, maxTokens: 100_000 },
          adaptive: true,
          wireShape: "openrouter"
        }
      }
    },
    sources: { openai: fakeSource("openai", [{ id: "opaque" }], calls) }
  });
  for (const [selection, expected] of invalid.slice(0, 5)) {
    const response = await backend.chat({
      model: "openai/opaque",
      messages: [],
      x_routekit: { version: 1, selection }
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "invalid_reasoning_control");
    assert.match(body.error.message, expected);
  }
  assert.equal(calls.length, 0, "malformed public metadata must never reach provider I/O");
});
