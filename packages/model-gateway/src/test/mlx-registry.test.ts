import assert from "node:assert/strict";
import { test } from "node:test";

import type { MlxBackend } from "../mlx-backend.js";
import {
  disposeAllMlxBackends,
  getOrCreateMlxBackend,
  resetMlxRegistryForTests,
  setMlxBackendFactoryForTests
} from "../routing/mlx-registry.js";

function mockBackend(model: string, closed: { value: boolean }): MlxBackend {
  return {
    defaultModel: model,
    chat: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    models: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    embeddings: async () => new Response(null, { status: 501 }),
    close: async () => {
      closed.value = true;
    }
  } as unknown as MlxBackend;
}

test("getOrCreateMlxBackend returns the same underlying instance for one model id", () => {
  const created: string[] = [];
  const closed = { value: false };
  resetMlxRegistryForTests();
  setMlxBackendFactoryForTests((model) => {
    created.push(model);
    return mockBackend(model, closed);
  });
  try {
    const first = getOrCreateMlxBackend("model-a");
    const second = getOrCreateMlxBackend("model-a");
    assert.notEqual(first, second);
    assert.equal(created.length, 1);
    assert.deepEqual(created, ["model-a"]);
  } finally {
    resetMlxRegistryForTests();
  }
});

test("getOrCreateMlxBackend returns different instances for different model ids", () => {
  const created: string[] = [];
  resetMlxRegistryForTests();
  setMlxBackendFactoryForTests((model) => {
    created.push(model);
    return mockBackend(model, { value: false });
  });
  try {
    getOrCreateMlxBackend("model-a");
    getOrCreateMlxBackend("model-b");
    assert.equal(created.length, 2);
    assert.deepEqual(created, ["model-a", "model-b"]);
  } finally {
    resetMlxRegistryForTests();
  }
});

test("LazyStartMlxBackend warns once across repeated chat calls", async () => {
  resetMlxRegistryForTests();
  setMlxBackendFactoryForTests((model) => mockBackend(model, { value: false }));
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  try {
    const backend = getOrCreateMlxBackend("model-a");
    await backend.chat({ messages: [{ role: "user", content: "hi" }] });
    await backend.chat({ messages: [{ role: "user", content: "again" }] });
    await backend.chat({ messages: [{ role: "user", content: "third" }] });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /starting local MLX server for model-a/);
  } finally {
    console.warn = original;
    resetMlxRegistryForTests();
  }
});

test("disposeAllMlxBackends closes registered backends and clears the registry", async () => {
  const closedA = { value: false };
  const closedB = { value: false };
  let factoryCalls = 0;
  resetMlxRegistryForTests();
  setMlxBackendFactoryForTests((model) => {
    factoryCalls += 1;
    return mockBackend(model, model === "model-a" ? closedA : closedB);
  });
  try {
    getOrCreateMlxBackend("model-a");
    getOrCreateMlxBackend("model-b");
    await disposeAllMlxBackends();
    assert.equal(closedA.value, true);
    assert.equal(closedB.value, true);
    getOrCreateMlxBackend("model-a");
    assert.equal(factoryCalls, 3);
  } finally {
    resetMlxRegistryForTests();
  }
});

test("resetMlxRegistryForTests restores the default factory", () => {
  resetMlxRegistryForTests();
  setMlxBackendFactoryForTests((model) => mockBackend(model, { value: false }));
  getOrCreateMlxBackend("model-a");
  resetMlxRegistryForTests();
  assert.doesNotThrow(() => resetMlxRegistryForTests());
});
