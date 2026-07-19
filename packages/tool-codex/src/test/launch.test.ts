import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentProfile, ToolLaunchSpec } from "@routekit/tools";

import {
  codexAgentRoleToml,
  codexCatalogEntries,
  codexLaunchConfigToml,
  codexModelCatalogJson
} from "../launch.js";

const SPEC: ToolLaunchSpec = {
  gatewayUrl: "http://127.0.0.1:9999",
  defaultModel: "opaque-primary",
  models: [
    { id: "opaque-primary", label: "Primary", aliases: ["primary-alias"] },
    { id: "opaque-secondary" }
  ],
  args: []
};

const PROFILE: AgentProfile = {
  id: "reviewer",
  model: "opaque-secondary",
  description: "Review changes.",
  instructions: "Return concise findings."
};

test("Codex launcher serializes namespaced models without interpreting provider ids", () => {
  const template = { slug: "stock", display_name: "Stock", visibility: "list" };
  const entries = codexCatalogEntries(SPEC, template, [
    template,
    { slug: "opaque-secondary", display_name: "duplicate" }
  ]);
  assert.deepEqual(
    entries.map((entry) => entry.slug),
    ["opaque-primary", "primary-alias", "opaque-secondary", "stock"]
  );
  assert.equal(entries[0]?.display_name, "Primary");
  assert.deepEqual(JSON.parse(codexModelCatalogJson(SPEC, template)).models, entries.slice(0, 3));
});

test("Codex launcher serializes one gateway provider and generic agent profiles", () => {
  const role = { ...PROFILE, configPath: "/tmp/reviewer.toml" };
  const config = codexLaunchConfigToml(SPEC, "/tmp/catalog.json", [role]);
  assert.match(config, /model = "opaque-primary"/);
  assert.match(config, /base_url = "http:\/\/127\.0\.0\.1:9999\/v1"/);
  assert.match(config, /config_file = "\/tmp\/reviewer\.toml"/);

  const profile = codexAgentRoleToml(PROFILE);
  assert.match(profile, /model = "opaque-secondary"/);
  assert.match(profile, /developer_instructions = "Return concise findings\."/);
});

test("Codex launcher projects codex models to native picker ids", () => {
  const spec: ToolLaunchSpec = {
    gatewayUrl: "http://127.0.0.1:9999",
    defaultModel: "codex/gpt-5.5",
    models: [
      { id: "codex/gpt-5.5", label: "GPT-5.5 subscription" },
      { id: "claude-code/claude-sonnet-4-6" }
    ],
    args: []
  };
  const template = {
    slug: "stock",
    display_name: "Stock",
    visibility: "list"
  };
  assert.deepEqual(
    codexCatalogEntries(spec, template).map((entry) => [
      entry.slug,
      entry.display_name
    ]),
    [
      ["gpt-5.5", "GPT-5.5 subscription"],
      [
        "claude-code/claude-sonnet-4-6",
        "claude-code/claude-sonnet-4-6"
      ]
    ]
  );
  assert.match(codexLaunchConfigToml(spec), /model = "gpt-5\.5"/);
  assert.match(
    codexAgentRoleToml({
      ...PROFILE,
      model: "codex/gpt-5.5"
    }),
    /model = "gpt-5\.5"/
  );
});
