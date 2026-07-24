import assert from "node:assert/strict";
import test from "node:test";

import {
  configuredProviderIds,
  DEFAULT_ROUTER_CONFIG
} from "@velum-labs/routekit-config";

import { buildProgram } from "../cli.js";
import { completionCandidates } from "../completion.js";
import {
  CONFIG_INIT_PROVIDER_IDS,
  configInitRouterConfig
} from "../commands/config.js";
import {
  isLaunchProviderId,
  LAUNCH_ACCOUNT_KINDS,
  LAUNCH_PROVIDER_IDS,
  LAUNCH_TOOL_IDS
} from "../launch-support.js";

test("the first-launch RouteKit contract is exact", () => {
  assert.deepEqual(LAUNCH_PROVIDER_IDS, [
    "openai",
    "anthropic",
    "openrouter",
    "codex",
    "claude-code"
  ]);
  assert.deepEqual(LAUNCH_ACCOUNT_KINDS, ["claude-code", "codex"]);
  assert.deepEqual(LAUNCH_TOOL_IDS, ["codex", "claude", "cursor"]);
});

test("default setup and public completion cannot drift outside the contract", () => {
  assert.equal(
    configuredProviderIds(DEFAULT_ROUTER_CONFIG).every(isLaunchProviderId),
    true
  );

  const providerCandidates = completionCandidates(buildProgram(), [
    "providers",
    "add",
    ""
  ]);
  assert.equal(providerCandidates.every(isLaunchProviderId), true);
  for (const notOffered of ["google", "cliproxy"]) {
    assert.equal(providerCandidates.includes(notOffered), false);
  }
});

test("config init starters stay inside the API launch contract", () => {
  assert.deepEqual(CONFIG_INIT_PROVIDER_IDS, ["openai", "anthropic", "openrouter"]);
  for (const provider of CONFIG_INIT_PROVIDER_IDS) {
    const config = configInitRouterConfig({ provider });
    assert.deepEqual(configuredProviderIds(config), [provider]);
    assert.match(config.defaultModel ?? "", new RegExp(`^${provider}/`));
  }
  assert.deepEqual(configInitRouterConfig({ empty: true }), { providers: {} });
});
