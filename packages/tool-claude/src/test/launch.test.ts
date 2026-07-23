import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentProfile, ToolLaunchContext } from "@routekit/tools";

import { claudeAgentsJson, claudeEnv, claudeLaunchArgs } from "../launch.js";

const PROFILES: readonly AgentProfile[] = [
  {
    id: "reviewer",
    model: "opaque-model",
    description: "Review changes.",
    instructions: "Return findings."
  }
];

function context(
  args: readonly string[],
  profiles = PROFILES,
  defaultModel = "opaque-model"
): ToolLaunchContext {
  return {
    spec: {
      gatewayUrl: "http://127.0.0.1",
      defaultModel,
      models: [{ id: defaultModel }],
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

test("Claude launcher projects claude-code models to native picker ids", () => {
  assert.deepEqual(
    claudeLaunchArgs(
      context([], [], "claude-code/claude-sonnet-4-6")
    ),
    ["--model", "claude-sonnet-4-6"]
  );
  assert.deepEqual(
    JSON.parse(
      claudeAgentsJson([
        {
          id: "native",
          model: "claude-code/claude-opus-4-8",
          description: "Use the subscription pool.",
          instructions: "Review."
        },
        {
          id: "cross",
          model: "codex/gpt-5.5",
          description: "Use Codex.",
          instructions: "Review."
        }
      ])
    ),
    {
      native: {
        description: "Use the subscription pool.",
        prompt: "Review.",
        model: "claude-opus-4-8"
      },
      cross: {
        description: "Use Codex.",
        prompt: "Review.",
        model: "claude-codex/gpt-5.5"
      }
    }
  );
});

test("Claude launcher forwards an explicit isolated config directory", () => {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = "/tmp/routekit-claude-config";
  try {
    assert.equal(
      claudeEnv("http://127.0.0.1:8080").CLAUDE_CONFIG_DIR,
      "/tmp/routekit-claude-config"
    );
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
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
