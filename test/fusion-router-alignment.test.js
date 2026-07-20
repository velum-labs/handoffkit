import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertCommittedFusionRouterAlignment,
  collectFusionModelIds,
  configuredProvidersFromRouterYaml,
  findMissingRouterProviders,
  providerFromModelId
} from "../scripts/lib/fusion-router-alignment.mjs";

const fusion = {
  version: "fusionkit.fusion.v4",
  ensembles: {
    default: {
      members: ["openrouter/org/member", "openai/member"],
      judge: "openrouter/org/judge",
      synthesizer: "anthropic/synth"
    }
  }
};

test("collects unique Fusion model ids and provider prefixes", () => {
  assert.deepEqual(collectFusionModelIds(fusion), [
    "anthropic/synth",
    "openai/member",
    "openrouter/org/judge",
    "openrouter/org/member"
  ]);
  assert.equal(providerFromModelId("openrouter/org/model"), "openrouter");
  assert.throws(() => providerFromModelId("unnamespaced"), /provider\/model/);
});

test("reads top-level provider keys from router YAML", () => {
  assert.deepEqual(
    [...configuredProvidersFromRouterYaml(
      [
        "providers:",
        "  openrouter:",
        "    strategy: sticky",
        '  "claude-code": {}',
        "defaultModel: openrouter/org/model"
      ].join("\n")
    )],
    ["openrouter", "claude-code"]
  );
});

test("reports Fusion providers missing from RouteKit config", () => {
  assert.deepEqual(
    findMissingRouterProviders(
      fusion,
      ["providers:", "  openrouter: {}", "  openai: {}", ""].join("\n")
    ),
    ["anthropic"]
  );
});

test("committed Fusion and RouteKit configs stay aligned", () => {
  assert.doesNotThrow(() => assertCommittedFusionRouterAlignment());
});
