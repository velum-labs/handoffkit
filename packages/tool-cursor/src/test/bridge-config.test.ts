import assert from "node:assert/strict";
import { test } from "node:test";

import { cursorBridgeEnv, cursorIdeModelsJson } from "../bridge-config.js";

type IdeModelEntry = { id: string; providerModel: string; baseUrl: string };

test("cursorIdeModelsJson lists the default fused model, other ensembles, then natives", () => {
  const parsed = JSON.parse(
    cursorIdeModelsJson({
      gatewayUrl: "http://127.0.0.1:9999",
      modelLabel: "fusion-panel",
      fusedModels: ["fusion-panel", "fusion-deep"],
      nativeModels: ["gpt-5.5", "fusion-deep"]
    })
  ) as IdeModelEntry[];
  assert.deepEqual(
    parsed.map((entry) => entry.id),
    ["fusion-panel", "fusion-deep", "gpt-5.5"]
  );
  assert.ok(parsed.every((entry) => entry.baseUrl.startsWith("http://127.0.0.1:9999")));
  assert.ok(parsed.every((entry) => entry.providerModel === entry.id));
});

test("cursorBridgeEnv seeds BRIDGE_MODELS_JSON when extra fused models exist", () => {
  const env = cursorBridgeEnv({
    port: 4321,
    gatewayUrl: "http://127.0.0.1:9999",
    modelName: "fusion-panel",
    fusedModels: ["fusion-panel", "fusion-deep"],
    nativeModels: ["gpt-5.5"],
    baseEnv: {}
  });
  // MODEL_NAME stays the session default for single-model bridges.
  assert.equal(env.MODEL_NAME, "fusion-panel");
  const models = JSON.parse(env.BRIDGE_MODELS_JSON ?? "[]") as IdeModelEntry[];
  assert.deepEqual(
    models.map((entry) => entry.id),
    ["fusion-panel", "fusion-deep", "gpt-5.5"]
  );
});

test("cursorBridgeEnv omits BRIDGE_MODELS_JSON on a single-ensemble launch", () => {
  const env = cursorBridgeEnv({
    port: 4321,
    gatewayUrl: "http://127.0.0.1:9999",
    modelName: "fusion-panel",
    fusedModels: ["fusion-panel"],
    baseEnv: {}
  });
  assert.equal(env.BRIDGE_MODELS_JSON, undefined);
});
