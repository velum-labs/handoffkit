import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FUSION_TOOLS,
  fusionAgentProfiles,
  fusionToolLaunchSpec,
  toolSelectOptions
} from "../fusion-quickstart.js";

const ENSEMBLES = [
  {
    name: "default",
    members: ["openai/route-fast", "anthropic/route-deep"],
    judge: "anthropic/route-deep"
  },
  {
    name: "review",
    members: ["anthropic/route-deep"],
    judge: "anthropic/route-deep"
  }
];

test("quickstart exposes all four tool launchers and serve", () => {
  assert.deepEqual(FUSION_TOOLS, [
    "codex",
    "claude",
    "cursor",
    "opencode",
    "serve"
  ]);
  assert.deepEqual(
    toolSelectOptions().map((option) => option.value),
    FUSION_TOOLS
  );
});

test("quickstart creates generic profiles from namespaced-model ensembles", () => {
  assert.deepEqual(fusionAgentProfiles(ENSEMBLES), [
    {
      id: "fusion-panel",
      model: "fusion-panel",
      description:
        'Delegate a task to the "default" compound (openai/route-fast, anthropic/route-deep).',
      instructions:
        'Answer the delegated task directly using the "default" compound.'
    },
    {
      id: "fusion-review",
      model: "fusion-review",
      description: 'Delegate a task to the "review" compound (anthropic/route-deep).',
      instructions:
        'Answer the delegated task directly using the "review" compound.'
    }
  ]);
});

test("quickstart authors one neutral ToolLaunchSpec for every tool adapter", () => {
  const spec = fusionToolLaunchSpec({
    gatewayUrl: "http://127.0.0.1:9000",
    defaultEnsemble: "default",
    ensembles: ENSEMBLES,
    args: ["--help"],
    cwd: "/tmp/repo",
    subagents: true
  });
  assert.equal(spec.gatewayUrl, "http://127.0.0.1:9000");
  assert.equal(spec.defaultModel, "fusion-panel");
  assert.deepEqual(
    spec.models.map((model) => model.id),
    ["fusion-panel", "fusion-review"]
  );
  assert.deepEqual(spec.agentProfiles, fusionAgentProfiles(ENSEMBLES));
  assert.deepEqual(spec.args, ["--help"]);
});

test("quickstart auth remains scoped to the public Fusion gateway", () => {
  const spec = fusionToolLaunchSpec({
    gatewayUrl: "http://127.0.0.1:9000",
    defaultEnsemble: "default",
    ensembles: ENSEMBLES,
    args: [],
    cwd: "/tmp/repo",
    authToken: "fusion-frontdoor-token"
  });
  assert.deepEqual(spec.auth, { token: "fusion-frontdoor-token" });
  assert.ok(
    JSON.stringify(spec).includes("fusion-frontdoor-token"),
    "the public tool launch spec carries only the Fusion gateway token"
  );
});
