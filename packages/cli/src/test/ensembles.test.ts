import assert from "node:assert/strict";
import { test } from "node:test";

import type { EnsembleRunSpec } from "../fusion/env.js";
import { gatewayEnsembleConfigs, unionPanelSpecs } from "../fusion/stack.js";

const DEFAULT_ENSEMBLE: EnsembleRunSpec = {
  name: "default",
  models: [
    { id: "gpt", model: "gpt-5.5", provider: "openai" },
    { id: "sonnet", model: "claude-sonnet-4-6", provider: "anthropic" }
  ],
  judgeModel: "gpt-5.5"
};

const DEEP_ENSEMBLE: EnsembleRunSpec = {
  name: "deep",
  models: [
    { id: "opus", model: "claude-opus-4-8", provider: "anthropic" },
    { id: "gpt", model: "gpt-5.5", provider: "openai" }
  ],
  judgeModel: "claude-opus-4-8",
  synthesizerModel: "opus",
  prompts: { judge: "DEEP JUDGE" }
};

test("unionPanelSpecs dedups shared member ids across ensembles", () => {
  const union = unionPanelSpecs([DEFAULT_ENSEMBLE, DEEP_ENSEMBLE]);
  assert.deepEqual(
    union.map((spec) => spec.id),
    ["gpt", "sonnet", "opus"]
  );
});

test("unionPanelSpecs rejects one id defined as two different specs", () => {
  const conflicting: EnsembleRunSpec = {
    name: "other",
    models: [{ id: "gpt", model: "gpt-5.5-mini", provider: "openai" }]
  };
  assert.throws(() => unionPanelSpecs([DEFAULT_ENSEMBLE, conflicting]), /defined differently/);
});

test("gatewayEnsembleConfigs lowers each ensemble into its gateway route", () => {
  const configs = gatewayEnsembleConfigs([DEFAULT_ENSEMBLE, DEEP_ENSEMBLE]);
  assert.equal(configs.length, 2);

  const byName = new Map(configs.map((config) => [config.name, config]));
  const fallback = byName.get("default");
  // The default ensemble keeps the canonical fusion-panel id.
  assert.equal(fallback?.modelId, "fusion-panel");
  assert.equal(fallback?.judgeEndpointId, "gpt");
  assert.equal(fallback?.judgeModelName, "gpt-5.5");
  assert.equal(fallback?.synthesizerEndpointId, undefined);
  assert.equal(fallback?.prompts, undefined);

  const deep = byName.get("deep");
  assert.equal(deep?.modelId, "fusion-deep");
  assert.deepEqual(
    deep?.models.map((model) => model.id),
    ["opus", "gpt"]
  );
  // Judge resolves by model name; synthesizer resolves by member id too.
  assert.equal(deep?.judgeEndpointId, "opus");
  assert.equal(deep?.judgeModelName, "claude-opus-4-8");
  assert.equal(deep?.synthesizerEndpointId, "opus");
  assert.deepEqual(deep?.prompts, { judge: "DEEP JUDGE" });
});
