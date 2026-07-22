import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  ACCOUNT_CONNECTORS,
  DEFAULT_MODEL_PRICING,
  GATEWAY_DEFAULT_MLX_MODEL,
  LOCAL_CATALOG_ENTRIES,
  LOCAL_PROBE_MODEL,
  PREFERRED_LOCAL_MODELS,
  REGISTRY,
  accountKindChoices,
  accountKindForCliproxyAuthType,
  providerDiscovery,
  resolveAccountConnector
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
  assert.equal(REGISTRY.providers.openai.wire.protocol, "openai");
  assert.equal(REGISTRY.providers.anthropic.wire.protocol, "anthropic");
  assert.equal(REGISTRY.providers.google.wire.protocol, "google");
  assert.equal(REGISTRY.providers.codex.discovery.responseShape, "codex");
  assert.equal(REGISTRY.subscriptions["claude-code"].discovery.path, "/v1/models");
  assert.equal(REGISTRY.subscriptions.codex.discovery.cacheFallback, true);
  assert.equal(REGISTRY.providers.openrouter.attributionHeaders["X-Title"], "RouteKit");
  assert.equal(REGISTRY.providers.openrouter.discovery.extraHeaders["X-Title"], "RouteKit");
  assert.equal(REGISTRY.subscriptions.codex.defaultHeaders.originator, "routekit");
});

test("account connector map resolves canonical kinds, aliases, and auth types", () => {
  // Native subscription kinds stay native; every native kind has full
  // subscription metadata in the subscriptions section.
  for (const [kind, info] of Object.entries(ACCOUNT_CONNECTORS)) {
    if (info.connector === "native") {
      assert.ok(kind in REGISTRY.subscriptions, `${kind} needs subscription metadata`);
      assert.equal(info.localOnly, undefined);
      assert.equal(info.cliproxyLoginFlag, undefined);
    } else {
      assert.equal(info.connector, "cliproxy");
      assert.ok(info.cliproxyLoginFlag?.startsWith("-"), `${kind} needs a login flag`);
      assert.equal(info.localOnly, true, `${kind} is ToS-restricted to local use`);
    }
  }
  assert.deepEqual(resolveAccountConnector("claude"), {
    kind: "claude-code",
    info: ACCOUNT_CONNECTORS["claude-code"]
  });
  assert.deepEqual(resolveAccountConnector("antigravity"), {
    kind: "gemini",
    info: ACCOUNT_CONNECTORS.gemini
  });
  assert.equal(resolveAccountConnector("unknown-kind"), undefined);
  assert.equal(accountKindForCliproxyAuthType("antigravity"), "gemini");
  assert.equal(accountKindForCliproxyAuthType("xai"), "grok");
  assert.equal(accountKindForCliproxyAuthType("vertex"), undefined);
  assert.deepEqual(accountKindChoices(), [
    "claude-code",
    "codex",
    "gemini",
    "grok",
    "kimi",
    "claude",
    "antigravity",
    "xai"
  ]);
});
