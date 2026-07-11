import assert from "node:assert/strict";
import { test } from "node:test";

import { claudeAgentsJson, claudeLaunchArgs } from "../launch.js";

const ENSEMBLES = [
  { name: "default", modelId: "fusion-panel", memberIds: ["kimi", "qwen3"] },
  { name: "deep", modelId: "fusion-deep", memberIds: ["opus", "gpt"] }
] as const;

test("claudeAgentsJson defines one agent per ensemble on the claude-aliased model", () => {
  const agents = JSON.parse(claudeAgentsJson(ENSEMBLES, "fusion-panel")) as Record<
    string,
    { description: string; prompt: string; model: string }
  >;
  assert.deepEqual(Object.keys(agents), ["fusion-panel", "fusion-deep"]);
  // Claude only accepts claude/anthropic-prefixed model ids; the gateway strips
  // the alias back when routing (claudeModelAlias parity).
  assert.equal(agents["fusion-panel"]?.model, "claude-fusion-panel");
  assert.equal(agents["fusion-deep"]?.model, "claude-fusion-deep");
  assert.match(agents["fusion-panel"]?.description ?? "", /default "default" fusion ensemble/);
  assert.match(agents["fusion-deep"]?.description ?? "", /"deep" fusion ensemble \(opus, gpt/);
  assert.match(agents["fusion-deep"]?.prompt ?? "", /panel-and-judge fusion/);
});

test("claudeLaunchArgs appends --agents by default", () => {
  const args = claudeLaunchArgs({
    toolArgs: ["--verbose"],
    modelLabel: "fusion-panel",
    fusedEnsembles: ENSEMBLES
  });
  assert.equal(args[0], "--verbose");
  assert.equal(args[1], "--agents");
  const agents = JSON.parse(args[2] ?? "{}") as Record<string, unknown>;
  assert.ok(agents["fusion-deep"] !== undefined);
});

test("claudeLaunchArgs skips ours when the user passed --agents", () => {
  for (const userArgs of [["--agents", "{}"], ["--agents={}"]]) {
    const args = claudeLaunchArgs({
      toolArgs: userArgs,
      modelLabel: "fusion-panel",
      fusedEnsembles: ENSEMBLES
    });
    assert.deepEqual(args, userArgs, "the user's --agents definition wins");
  }
});

test("claudeLaunchArgs honors the subagents opt-out and empty ensembles", () => {
  const optedOut = claudeLaunchArgs({
    toolArgs: [],
    modelLabel: "fusion-panel",
    fusedEnsembles: ENSEMBLES,
    subagents: false
  });
  assert.deepEqual(optedOut, []);
  const noEnsembles = claudeLaunchArgs({ toolArgs: [], modelLabel: "fusion-panel" });
  assert.deepEqual(noEnsembles, []);
});
