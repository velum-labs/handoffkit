import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentProfile, ToolLaunchContext } from "@routekit/tools";

import { claudeAgentsJson, claudeLaunchArgs } from "../launch.js";

const PROFILES: readonly AgentProfile[] = [
  {
    id: "reviewer",
    model: "opaque-model",
    description: "Review changes.",
    instructions: "Return findings."
  }
];

function context(args: readonly string[], profiles = PROFILES): ToolLaunchContext {
  return {
    spec: {
      gatewayUrl: "http://127.0.0.1",
      defaultModel: "opaque-model",
      models: [{ id: "opaque-model" }],
      agentProfiles: profiles,
      args
    },
    log: () => undefined,
    prepareForPassthrough: () => undefined,
    registerPort: (_name, port) => `http://127.0.0.1:${port}`,
    unregisterPort: () => undefined,
    registerDisposer: () => undefined
  };
}

test("claudeAgentsJson serializes generic profiles", () => {
  assert.deepEqual(JSON.parse(claudeAgentsJson(PROFILES)), {
    reviewer: {
      description: "Review changes.",
      prompt: "Return findings.",
      model: "claude-opaque-model"
    }
  });
});

test("claudeLaunchArgs adds profiles unless the user supplied agents", () => {
  const args = claudeLaunchArgs(context(["--verbose"]));
  assert.deepEqual(args.slice(0, 4), [
    "--model",
    "claude-opaque-model",
    "--verbose",
    "--agents"
  ]);
  assert.deepEqual(claudeLaunchArgs(context(["--agents={}"])), [
    "--model",
    "claude-opaque-model",
    "--agents={}"
  ]);
  assert.deepEqual(claudeLaunchArgs(context([], [])), [
    "--model",
    "claude-opaque-model"
  ]);
  assert.deepEqual(
    claudeLaunchArgs(context(["--model", "claude-user-selected"], [])),
    ["--model", "claude-user-selected"]
  );
});
