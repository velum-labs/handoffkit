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
