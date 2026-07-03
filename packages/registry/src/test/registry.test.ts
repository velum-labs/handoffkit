import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BENCHMARK_PANEL_PRESETS,
  DEFAULT_MODEL_PRICING,
  GATEWAY_DEFAULT_MLX_MODEL,
  LOCAL_CATALOG_ENTRIES,
  LOCAL_PROBE_MODEL,
  PREFERRED_LOCAL_MODELS,
  providerDiscovery
} from "../index.js";

test("local catalog defaults reference valid catalog metadata", () => {
  const repos = new Set(LOCAL_CATALOG_ENTRIES.map((entry) => entry.repo));
  assert.ok(repos.has(LOCAL_PROBE_MODEL));
  for (const preferred of PREFERRED_LOCAL_MODELS) {
    assert.ok(repos.has(preferred.repo), `${preferred.id} must reference a local catalog entry`);
  }
  assert.equal(typeof GATEWAY_DEFAULT_MLX_MODEL, "string");
  assert.ok(GATEWAY_DEFAULT_MLX_MODEL.length > 0);
});

test("benchmark panel presets reference their judge and synthesizer members", () => {
  for (const preset of Object.values(BENCHMARK_PANEL_PRESETS)) {
    const ids = new Set(preset.members.map((member) => member.id));
    assert.ok(ids.has(preset.judgeId), `${preset.panelId} judgeId must be a member id`);
    assert.ok(ids.has(preset.synthesizerId), `${preset.panelId} synthesizerId must be a member id`);
  }
});

test("pricing registry exposes generated and manual prices through one table", () => {
  assert.deepEqual(DEFAULT_MODEL_PRICING["gpt-5.5"], {
    inputPer1mTokens: 1.25,
    outputPer1mTokens: 10
  });
  assert.ok(Object.keys(DEFAULT_MODEL_PRICING).length >= 5);
});

test("provider discovery metadata drives OpenRouter picker defaults", () => {
  const discovery = providerDiscovery("openrouter");
  assert.equal(discovery?.path, "/v1/models");
  assert.equal(discovery?.responseShape, "openai");
  assert.equal(discovery?.pickerDefaultSource, "curated");
});
