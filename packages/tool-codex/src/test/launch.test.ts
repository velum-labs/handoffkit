import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AgentProfile, ToolLaunchSpec } from "@velum-labs/routekit-tools";

import {
  codexAgentRoleToml,
  codexCatalogEntries,
  createIsolatedCodexHome,
  codexLaunchConfigToml,
  codexModelCatalogJson
} from "../launch.js";

const SPEC: ToolLaunchSpec = {
  gatewayUrl: "http://127.0.0.1:9999",
  defaultModel: "opaque-primary",
  models: [
    {
      id: "opaque-primary",
      label: "Primary",
      aliases: ["primary-alias"],
      reasoning: {
        status: "supported",
        efforts: [{ id: "quick" }, { id: "deep" }],
        defaultEffort: "quick",
        provenance: "provider"
      }
    },
    {
      id: "opaque-secondary",
      reasoning: { status: "unknown", provenance: "unknown" }
    }
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
  const template = {
    slug: "stock",
    display_name: "Stock",
    visibility: "list",
    supported_reasoning_levels: [{ effort: "template" }],
    default_reasoning_level: "template"
  };
  const entries = codexCatalogEntries(SPEC, template, [
    template,
    { slug: "opaque-secondary", display_name: "duplicate" }
  ]);
  assert.deepEqual(
    entries.map((entry) => entry.slug),
    ["opaque-primary", "primary-alias", "opaque-secondary", "stock"]
  );
  assert.equal(entries[0]?.display_name, "Primary");
  assert.deepEqual(entries[0]?.supported_reasoning_levels, [
    { effort: "quick", description: "quick" },
    { effort: "deep", description: "deep" }
  ]);
  // Codex rejects the whole catalog file when any entry omits this field, so
  // undiscovered models must serialize an explicit empty list.
  assert.deepEqual(entries[2]?.supported_reasoning_levels, []);
  assert.ok(
    entries
      .slice(0, 3)
      .every((entry) => Array.isArray(entry.supported_reasoning_levels)),
    "every gateway-routed entry carries supported_reasoning_levels"
  );
  assert.deepEqual(JSON.parse(codexModelCatalogJson(SPEC, template)).models, entries.slice(0, 3));
});

test("Codex launcher neutralizes stock-model behavior fields from the template", () => {
  const template = {
    slug: "gpt-stock",
    display_name: "Stock",
    visibility: "list",
    supported_reasoning_levels: [{ effort: "medium" }],
    default_reasoning_level: "medium",
    // Real stock entries carry fields that change how Codex talks to the
    // model; none of them may leak into gateway-routed entries.
    tool_mode: "code_mode_only",
    use_responses_lite: true,
    additional_speed_tiers: ["fast"],
    service_tiers: [{ id: "priority", name: "Fast" }],
    default_service_tier: "priority",
    base_instructions: "You are Codex, an agent based on GPT-5.",
    model_messages: {
      instructions_template: "You are Codex, an agent based on GPT-5.",
      instructions_variables: null
    }
  };
  const [entry] = codexCatalogEntries(SPEC, template);
  assert.ok(entry);
  assert.equal("tool_mode" in entry, false);
  assert.equal("default_service_tier" in entry, false);
  assert.equal(entry.use_responses_lite, false);
  assert.deepEqual(entry.additional_speed_tiers, []);
  assert.deepEqual(entry.service_tiers, []);
  // The developer message must not claim a stock model's identity.
  assert.equal(entry.base_instructions, "You are a coding agent.");
  assert.deepEqual(entry.model_messages, {
    instructions_template: "You are a coding agent.",
    instructions_variables: null
  });
  // A minimal template gains no wire-shape fields it never had.
  const [minimal] = codexCatalogEntries(SPEC, { slug: "s", visibility: "list" });
  assert.ok(minimal);
  assert.equal("use_responses_lite" in minimal, false);
  assert.equal("service_tiers" in minimal, false);
});

test("Codex launcher passes stock ModelInfo through for codex-native models only", () => {
  const spec: ToolLaunchSpec = {
    gatewayUrl: "http://127.0.0.1:9999",
    defaultModel: "codex/gpt-5.5",
    models: [
      { id: "codex/gpt-5.5" },
      // A foreign model that happens to collide with a stock slug must NOT
      // inherit the stock entry: it is not the Codex-native model.
      { id: "claude-code/gpt-5.4" },
      { id: "claude-code/claude-sonnet-5" }
    ],
    args: []
  };
  const template = { slug: "stock", display_name: "Stock", visibility: "list" };
  const stock = [
    {
      slug: "gpt-5.5",
      display_name: "GPT-5.5",
      description: "Stock Codex model.",
      base_instructions: "You are Codex, an agent based on GPT-5.",
      tool_mode: "code_mode_only",
      use_responses_lite: true,
      supported_reasoning_levels: [{ effort: "xhigh" }],
      default_reasoning_level: "xhigh",
      visibility: "hidden"
    },
    { slug: "gpt-5.4", display_name: "GPT-5.4" },
    { slug: "gpt-unrelated", display_name: "Unrelated" }
  ];
  const entries = codexCatalogEntries(spec, template, stock, {
    appendUnlistedStock: false
  });
  assert.deepEqual(
    entries.map((entry) => entry.slug),
    ["gpt-5.5", "claude-code/gpt-5.4", "claude-code/claude-sonnet-5"]
  );
  const [native, foreignCollision, foreign] = entries;
  // Native passthrough keeps the tuned stock behavior, pinned to list + HTTP.
  assert.equal(native?.base_instructions, "You are Codex, an agent based on GPT-5.");
  assert.equal(native?.tool_mode, "code_mode_only");
  assert.equal(native?.use_responses_lite, true);
  assert.equal(native?.default_reasoning_level, "xhigh");
  assert.equal(native?.visibility, "list");
  assert.equal(native?.prefer_websockets, false);
  // Foreign models never inherit stock entries, colliding slug or not.
  assert.equal(foreignCollision?.base_instructions, undefined);
  assert.equal("tool_mode" in (foreignCollision ?? {}), false);
  assert.equal("tool_mode" in (foreign ?? {}), false);
  // Unlisted stock models stay out when appending is disabled.
  assert.ok(!entries.some((entry) => entry.slug === "gpt-unrelated"));
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

test("isolated Codex homes live under the user cache instead of the system temp root", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-codex-home-test-"));
  const userHome = join(root, "home");
  try {
    const isolated = createIsolatedCodexHome("driver-", { HOME: userHome });
    assert.ok(
      isolated.startsWith(join(userHome, ".cache", "routekit", "codex", "driver-"))
    );
    assert.equal(existsSync(isolated), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
