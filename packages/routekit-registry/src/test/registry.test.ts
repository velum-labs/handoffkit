import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  DEFAULT_MODEL_PRICING,
  GATEWAY_DEFAULT_MLX_MODEL,
  LOCAL_CATALOG_ENTRIES,
  LOCAL_PROBE_MODEL,
  PREFERRED_LOCAL_MODELS,
  REGISTRY,
  providerDiscovery
} from "../index.js";

test("neutral generated registry excludes product and panel data", () => {
  assert.equal("fusion" in REGISTRY, false);
  assert.equal("defaultCloudPanel" in REGISTRY.modelCatalog, false);
  assert.equal("benchmarkPanels" in REGISTRY.modelCatalog, false);
  const generatedSource = readFileSync(
    new URL("../../src/generated/data.ts", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(generatedSource, /fusionkit/i);
});

test("local catalog defaults reference valid catalog metadata", () => {
  const repos = new Set(LOCAL_CATALOG_ENTRIES.map((entry) => entry.repo));
  assert.ok(repos.has(LOCAL_PROBE_MODEL));
  for (const preferred of PREFERRED_LOCAL_MODELS) {
    assert.ok(repos.has(preferred.repo), `${preferred.id} must reference a local catalog entry`);
  }
  assert.ok(GATEWAY_DEFAULT_MLX_MODEL.length > 0);
});

test("neutral pricing and provider metadata remain available", () => {
  assert.deepEqual(DEFAULT_MODEL_PRICING["gpt-5.5"], {
    inputPer1mTokens: 1.25,
    outputPer1mTokens: 10
  });
  const discovery = providerDiscovery("openrouter");
  assert.equal(discovery?.path, "/v1/models");
  assert.equal(discovery?.pickerDefaultSource, "curated");
  assert.equal(REGISTRY.providers.openrouter.attributionHeaders["X-Title"], "RouteKit");
  assert.equal(REGISTRY.providers.openrouter.discovery.extraHeaders["X-Title"], "RouteKit");
  assert.equal(REGISTRY.subscriptions.codex.defaultHeaders.originator, "routekit");
});
