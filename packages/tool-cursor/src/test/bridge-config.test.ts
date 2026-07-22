import assert from "node:assert/strict";
import { test } from "node:test";

import { cursorBridgeEnv, cursorIdeModelsJson } from "../bridge-config.js";

type IdeModelEntry = {
  id: string;
  providerModel: string;
  baseUrl: string;
  reasoning?: { efforts?: Array<{ id: string }> };
};
type IdeModelEnvelope = { version: number; models: IdeModelEntry[] };

test("cursorIdeModelsJson preserves opaque model order and removes duplicates", () => {
  const parsed = JSON.parse(
    cursorIdeModelsJson({
      gatewayUrl: "http://127.0.0.1:9999",
      modelLabel: "opaque-primary",
      models: [
        {
          id: "opaque-primary",
          reasoning: {
            status: "supported",
            efforts: [{ id: "quick" }, { id: "deep" }],
            provenance: "provider"
          }
        },
        { id: "opaque-secondary" },
        { id: "native-model" },
        { id: "opaque-secondary" }
      ]
    })
  ) as IdeModelEnvelope;
  assert.equal(parsed.version, 2);
  assert.deepEqual(
    parsed.models.map((entry) => entry.id),
    ["opaque-primary", "opaque-secondary", "native-model"]
  );
  assert.ok(parsed.models.every((entry) => entry.baseUrl.startsWith("http://127.0.0.1:9999")));
  assert.ok(parsed.models.every((entry) => entry.providerModel === entry.id));
  assert.deepEqual(parsed.models[0]?.reasoning?.efforts, [
    { id: "quick" },
    { id: "deep" }
  ]);
});

test("cursorBridgeEnv seeds BRIDGE_MODELS_JSON for multiple opaque models", () => {
  const env = cursorBridgeEnv({
    port: 4321,
    gatewayUrl: "http://127.0.0.1:9999",
    modelName: "opaque-primary",
    models: [
      { id: "opaque-primary" },
      { id: "opaque-secondary" },
      { id: "native-model" }
    ],
    baseEnv: {}
  });
  // MODEL_NAME stays the session default for single-model bridges.
  assert.equal(env.MODEL_NAME, "opaque-primary");
  const models = JSON.parse(env.BRIDGE_MODELS_JSON ?? "[]") as IdeModelEntry[];
  assert.deepEqual(
    models.map((entry) => entry.id),
    ["opaque-primary", "opaque-secondary", "native-model"]
  );
});

test("cursorBridgeEnv omits BRIDGE_MODELS_JSON for one model", () => {
  const env = cursorBridgeEnv({
    port: 4321,
    gatewayUrl: "http://127.0.0.1:9999",
    modelName: "opaque-primary",
    models: [{ id: "opaque-primary" }],
    baseEnv: {}
  });
  assert.equal(env.BRIDGE_MODELS_JSON, undefined);
});
