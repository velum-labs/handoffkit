import assert from "node:assert/strict";
import { test } from "node:test";

import type { Backend } from "../backend.js";
import { CatalogBackend, EndpointPool, parseRouterConfig } from "../router.js";

function fakeBackend(
  name: string,
  invoke: () => Response = () => Response.json({ name })
): Backend {
  return {
    defaultModel: name,
    chat: async () => invoke(),
    models: async () => Response.json({ object: "list", data: [{ id: name }] }),
    embeddings: async () => invoke()
  };
}

test("RouterConfig validates endpoint identity and defaults", () => {
  const config = parseRouterConfig({
    endpoints: [
      {
        endpointId: "opaque-a",
        model: "provider-model",
        baseUrl: "https://provider.example/v1"
      }
    ]
  });
  assert.equal(config.endpoints[0]?.dialect, "openai");
  assert.equal(config.strategy, "capacity_weighted");
  assert.throws(
    () =>
      parseRouterConfig({
        endpoints: [
          {
            endpointId: "opaque-a",
            instanceId: "duplicate",
            model: "provider-model",
            baseUrl: "https://one.example/v1"
          },
          {
            endpointId: "opaque-b",
            instanceId: "duplicate",
            model: "provider-model",
            baseUrl: "https://two.example/v1"
          }
        ]
      }),
    /instance ids must be unique/
  );
  assert.throws(
    () =>
      parseRouterConfig({
        endpoints: [
          {
            endpointId: "opaque-a",
            model: "provider-model",
            baseUrl: "https://provider.example/v1",
            apiKey: "must-not-be-stored-in-router-config"
          }
        ]
      }),
    /unrecognized key/i
  );
});

test("CatalogBackend advertises opaque ids and balances endpoint instances", async () => {
  const calls: string[] = [];
  const backend = new CatalogBackend({
    config: {
      strategy: "round_robin",
      endpoints: [
        {
          endpointId: "opaque-a",
          model: "native-a",
          baseUrl: "https://one.example/v1",
          capabilities: { tools: "supported", streaming: "supported" }
        },
        {
          endpointId: "opaque-a",
          model: "native-a",
          baseUrl: "https://two.example/v1",
          capabilities: { tools: "supported", streaming: "supported" }
        }
      ]
    },
    createBackend: (endpoint) =>
      fakeBackend(endpoint.baseUrl, () => {
        calls.push(endpoint.baseUrl);
        return Response.json({ ok: true });
      })
  });

  assert.deepEqual(backend.listModelIds(), ["opaque-a"]);
  assert.equal(backend.resolveModel("unknown"), "opaque-a");
  assert.equal(backend.capabilities("opaque-a").tools, "supported");
  await backend.chat({ model: "opaque-a", messages: [] });
  await backend.chat({ model: "opaque-a", messages: [] });
  assert.deepEqual(calls, ["https://one.example/v1", "https://two.example/v1"]);

  const models = (await (await backend.models()).json()) as {
    data: Array<{ id: string; capabilities: Record<string, string> }>;
  };
  assert.equal(models.data[0]?.id, "opaque-a");
  assert.equal(models.data[0]?.capabilities.streaming, "supported");
});

test("EndpointPool cools a throttled instance and retries another", async () => {
  const calls: string[] = [];
  const backend = new CatalogBackend({
    config: {
      strategy: "round_robin",
      cooldownMs: 60_000,
      endpoints: [
        {
          endpointId: "opaque",
          model: "native",
          baseUrl: "https://limited.example/v1"
        },
        {
          endpointId: "opaque",
          model: "native",
          baseUrl: "https://healthy.example/v1"
        }
      ]
    },
    createBackend: (endpoint) =>
      fakeBackend(endpoint.baseUrl, () => {
        calls.push(endpoint.baseUrl);
        return endpoint.baseUrl.includes("limited")
          ? Response.json({ error: "limited" }, { status: 429, headers: { "retry-after": "60" } })
          : Response.json({ ok: true });
      })
  });

  const response = await backend.chat({ model: "opaque", messages: [] });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    "https://limited.example/v1",
    "https://healthy.example/v1"
  ]);
  calls.length = 0;
  await backend.chat({ model: "opaque", messages: [] });
  assert.deepEqual(calls, ["https://healthy.example/v1"]);
});

test("EndpointPool does not poison an instance after caller cancellation", async () => {
  let calls = 0;
  const backend = new CatalogBackend({
    config: {
      cooldownMs: 60_000,
      endpoints: [
        {
          endpointId: "opaque",
          model: "native",
          baseUrl: "https://cancel.example/v1"
        }
      ]
    },
    createBackend: (endpoint) =>
      fakeBackend(endpoint.baseUrl, () => {
        calls += 1;
        if (calls === 1) {
          throw new DOMException("cancelled", "AbortError");
        }
        return Response.json({ ok: true });
      })
  });

  await assert.rejects(
    backend.chat({ model: "opaque", messages: [] }),
    (error: unknown) => error instanceof Error && error.name === "AbortError"
  );
  const recovered = await backend.chat({ model: "opaque", messages: [] });
  assert.equal(recovered.status, 200);
  assert.equal(calls, 2);
});

test("EndpointPool exposes explicit health and cooldown controls", async () => {
  const calls: string[] = [];
  const firstConfig = {
    endpointId: "opaque",
    instanceId: "first",
    model: "native",
    baseUrl: "https://first.example/v1",
    dialect: "openai" as const
  };
  const secondConfig = {
    endpointId: "opaque",
    instanceId: "second",
    model: "native",
    baseUrl: "https://second.example/v1",
    dialect: "openai" as const
  };
  const pool = new EndpointPool({
    endpointId: "opaque",
    strategy: "round_robin",
    instances: [
      {
        config: firstConfig,
        backend: fakeBackend("first", () => {
          calls.push("first");
          return Response.json({ ok: true });
        })
      },
      {
        config: secondConfig,
        backend: fakeBackend("second", () => {
          calls.push("second");
          return Response.json({ ok: true });
        })
      }
    ]
  });

  assert.deepEqual(pool.instanceIds(), ["first", "second"]);
  pool.markUnhealthy("first");
  await pool.chat({ model: "opaque", messages: [] });
  assert.deepEqual(calls, ["second"]);

  pool.markHealthy("first");
  pool.markCooldown("second", 60_000);
  calls.length = 0;
  await pool.chat({ model: "opaque", messages: [] });
  assert.deepEqual(calls, ["first"]);
});
