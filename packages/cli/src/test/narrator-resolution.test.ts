import assert from "node:assert/strict";
import { test } from "node:test";

import { NARRATOR_ENDPOINT_ID, resolveNarratorModel, routerConfigYaml } from "../fusion/stack.js";
import type { PanelModelSpec } from "../fusion/env.js";

const PANEL: PanelModelSpec[] = [
  { id: "gpt", model: "gpt-5.5", provider: "openai" },
  { id: "sonnet", model: "claude-sonnet-4-6", provider: "anthropic" },
  { id: "qwen", model: "mlx-community/Qwen3-1.7B-4bit", provider: "mlx" }
];

test("resolveNarratorModel reuses a panel member's endpoint by id or model name", () => {
  assert.deepEqual(resolveNarratorModel("sonnet", PANEL), { kind: "endpoint", endpointId: "sonnet" });
  assert.deepEqual(resolveNarratorModel("gpt-5.5", PANEL), { kind: "endpoint", endpointId: "gpt" });
  // An MLX panel member is also just an endpoint (the router already fronts it).
  assert.deepEqual(resolveNarratorModel("mlx-community/Qwen3-1.7B-4bit", PANEL), {
    kind: "endpoint",
    endpointId: "qwen"
  });
});

test("resolveNarratorModel turns provider/model tokens into a narrator endpoint", () => {
  assert.deepEqual(resolveNarratorModel("openai/gpt-5.5-mini", PANEL), {
    kind: "extra-endpoint",
    spec: { id: NARRATOR_ENDPOINT_ID, model: "gpt-5.5-mini", provider: "openai", keyEnv: "OPENAI_API_KEY" }
  });
  assert.deepEqual(resolveNarratorModel("google/gemini-2.5-flash", PANEL), {
    kind: "extra-endpoint",
    spec: { id: NARRATOR_ENDPOINT_ID, model: "gemini-2.5-flash", provider: "google", keyEnv: "GEMINI_API_KEY" }
  });
  // OpenRouter model ids keep their own slashes.
  assert.deepEqual(resolveNarratorModel("openrouter/deepseek/deepseek-chat:free", PANEL), {
    kind: "extra-endpoint",
    spec: {
      id: NARRATOR_ENDPOINT_ID,
      model: "deepseek/deepseek-chat:free",
      provider: "openrouter",
      keyEnv: "OPENROUTER_API_KEY"
    }
  });
});

test("resolveNarratorModel maps subscription prefixes to auth endpoints", () => {
  assert.deepEqual(resolveNarratorModel("claude-code/claude-haiku-4-5", PANEL), {
    kind: "extra-endpoint",
    spec: {
      id: NARRATOR_ENDPOINT_ID,
      model: "claude-haiku-4-5",
      provider: "anthropic",
      auth: "claude-code"
    }
  });
  assert.deepEqual(resolveNarratorModel("codex/gpt-5.5", PANEL), {
    kind: "extra-endpoint",
    spec: { id: NARRATOR_ENDPOINT_ID, model: "gpt-5.5", auth: "codex" }
  });
});

test("resolveNarratorModel treats anything else as a local MLX model path", () => {
  // A bare HF-style repo (the historical --reasoning-model shape).
  assert.deepEqual(resolveNarratorModel("mlx-community/gemma-3-1b-it-4bit", PANEL), {
    kind: "mlx",
    model: "mlx-community/gemma-3-1b-it-4bit"
  });
  // No slash at all: also local.
  assert.deepEqual(resolveNarratorModel("some-local-model", PANEL), {
    kind: "mlx",
    model: "some-local-model"
  });
});

test("a narrator extra endpoint folds into the router config alongside the panel", () => {
  const resolution = resolveNarratorModel("openai/gpt-5.5-mini", PANEL);
  assert.equal(resolution.kind, "extra-endpoint");
  if (resolution.kind !== "extra-endpoint") return;
  const yaml = routerConfigYaml({
    specs: [...PANEL.filter((spec) => spec.provider !== "mlx"), resolution.spec],
    mlxUrls: {},
    judgeId: "gpt"
  });
  assert.match(yaml, /id: narrator/);
  assert.match(yaml, /model: gpt-5\.5-mini/);
  // The narrator never becomes the judge/synthesizer.
  assert.match(yaml, /judge_model: gpt/);
  assert.match(yaml, /synthesizer_model: gpt/);
});
