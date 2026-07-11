import assert from "node:assert/strict";
import { test } from "node:test";

import { LOCAL_MODEL_LABEL } from "@fusionkit/tools";

import { opencodeConfig, opencodeModelArg } from "../index.js";

test("opencodeConfig registers the gateway as an OpenAI-compatible provider", () => {
  const config = opencodeConfig("http://127.0.0.1:9999", "panel-model");
  assert.equal(config.$schema, "https://opencode.ai/config.json");

  const provider = config.provider as Record<string, Record<string, unknown>>;
  const entry = provider[LOCAL_MODEL_LABEL];
  assert.ok(entry, "expected a provider entry under the local model label");
  assert.equal(entry.npm, "@ai-sdk/openai-compatible");
  assert.deepEqual(entry.options, { baseURL: "http://127.0.0.1:9999/v1" });
  assert.deepEqual(entry.models, { "panel-model": { name: "panel-model" } });
});

test("opencodeConfig lists native models alongside the fused default", () => {
  const config = opencodeConfig("http://127.0.0.1:9999", "fusion-panel", [
    "gpt-5.5",
    "claude-opus-4-8",
    "fusion-panel"
  ]);
  const provider = config.provider as Record<string, Record<string, unknown>>;
  const models = provider[LOCAL_MODEL_LABEL]?.models as Record<string, { name: string }>;
  // The fused model stays first/default; each native model is added once (no dup).
  assert.deepEqual(Object.keys(models), ["fusion-panel", "gpt-5.5", "claude-opus-4-8"]);
});

test("opencodeModelArg namespaces the model under the local provider", () => {
  assert.equal(
    opencodeModelArg("panel-model"),
    `${LOCAL_MODEL_LABEL}/panel-model`
  );
});

test("opencodeConfig lists every fused ensemble model and defines a subagent each", () => {
  const config = opencodeConfig(
    "http://127.0.0.1:9999",
    "fusion-panel",
    ["gpt-5.5"],
    ["fusion-panel", "fusion-deep"],
    [
      { name: "default", modelId: "fusion-panel", memberIds: ["kimi", "qwen3"] },
      { name: "deep", modelId: "fusion-deep", memberIds: ["opus"] }
    ]
  );
  const provider = config.provider as Record<string, Record<string, unknown>>;
  const models = provider[LOCAL_MODEL_LABEL]?.models as Record<string, { name: string }>;
  assert.deepEqual(Object.keys(models), ["fusion-panel", "fusion-deep", "gpt-5.5"]);

  const agent = config.agent as Record<
    string,
    { mode: string; model: string; description: string; prompt: string }
  >;
  assert.deepEqual(Object.keys(agent), ["fusion-panel", "fusion-deep"]);
  assert.equal(agent["fusion-deep"]?.mode, "subagent");
  assert.equal(agent["fusion-deep"]?.model, `${LOCAL_MODEL_LABEL}/fusion-deep`);
  assert.match(agent["fusion-panel"]?.description ?? "", /default "default" fusion ensemble/);
  assert.match(agent["fusion-deep"]?.prompt ?? "", /panel-and-judge fusion/);
});

test("opencodeConfig omits the agent map without ensembles", () => {
  const config = opencodeConfig("http://127.0.0.1:9999", "fusion-panel", ["gpt-5.5"]);
  assert.equal(config.agent, undefined);
});
