import assert from "node:assert/strict";
import { test } from "node:test";

import { FUSION_CONFIG_VERSION } from "../fusion-config.js";
import type { FusionConfig } from "../fusion-config.js";
import { DEFAULT_CLOUD_PANEL, DEFAULT_TRIO } from "../fusion/env.js";
import { resolveEffectiveConfig } from "../fusion/effective-config.js";

test("the default cloud panel is a decorrelated three-vendor trio", () => {
  assert.equal(DEFAULT_CLOUD_PANEL.length, 3);
  const providers = DEFAULT_CLOUD_PANEL.map((spec) => spec.provider);
  // Three distinct vendors (genuinely decorrelated, not a pair).
  assert.equal(new Set(providers).size, 3);
  assert.deepEqual([...providers].sort(), ["anthropic", "google", "openai"]);
  // The added Google member uses a model id the google provider path accepts.
  const gemini = DEFAULT_CLOUD_PANEL.find((spec) => spec.provider === "google");
  assert.equal(gemini?.model, "gemini-2.5-pro");
});

test("with no config, every field resolves to its built-in default", () => {
  const effective = resolveEffectiveConfig(undefined);
  assert.deepEqual(effective.tool, { value: "codex", source: "default" });
  assert.deepEqual(effective.local, { value: false, source: "default" });
  assert.equal(effective.panel.source, "default");
  assert.equal(effective.panel.value.length, 3);
  // Default judge is the first panel member's model.
  assert.deepEqual(effective.judgeModel, { value: "gpt-5.5", source: "default" });
  assert.deepEqual(effective.onRateLimit, { value: "fusion", source: "default" });
  assert.deepEqual(effective.portless, { value: true, source: "default" });
  assert.deepEqual(effective.observe, { value: false, source: "default" });
});

test("local=true (config) flips the default panel to the local MLX trio", () => {
  const config: FusionConfig = { version: FUSION_CONFIG_VERSION, local: true };
  const effective = resolveEffectiveConfig(config);
  assert.deepEqual(effective.local, { value: true, source: "config" });
  assert.equal(effective.panel.source, "default");
  assert.deepEqual(
    effective.panel.value.map((spec) => spec.model),
    DEFAULT_TRIO.map((spec) => spec.model)
  );
});

test("config values win over defaults and are tagged as config-sourced", () => {
  const config: FusionConfig = {
    version: FUSION_CONFIG_VERSION,
    tool: "claude",
    ensembles: {
      default: {
        panel: [{ id: "gpt", model: "gpt-5.5", provider: "openai", keyEnv: "OPENAI_API_KEY" }],
        judgeModel: "gpt-5.5"
      }
    },
    observe: true,
    onRateLimit: "passthrough"
  };
  const effective = resolveEffectiveConfig(config);
  assert.deepEqual(effective.tool, { value: "claude", source: "config" });
  assert.equal(effective.panel.source, "config");
  assert.equal(effective.panel.value.length, 1);
  assert.deepEqual(effective.judgeModel, { value: "gpt-5.5", source: "config" });
  assert.deepEqual(effective.observe, { value: true, source: "config" });
  assert.deepEqual(effective.onRateLimit, { value: "passthrough", source: "config" });
});

test("explicit flag overrides win over the config file (full precedence)", () => {
  const config: FusionConfig = {
    version: FUSION_CONFIG_VERSION,
    tool: "claude",
    local: false,
    onRateLimit: "passthrough"
  };
  const effective = resolveEffectiveConfig(config, {
    tool: "cursor",
    local: true,
    onRateLimit: "fail"
  });
  assert.deepEqual(effective.tool, { value: "cursor", source: "flag" });
  assert.deepEqual(effective.local, { value: true, source: "flag" });
  assert.deepEqual(effective.onRateLimit, { value: "fail", source: "flag" });
  // Flag local=true also shifts the default panel to the local trio.
  assert.equal(effective.panel.source, "default");
  assert.deepEqual(
    effective.panel.value.map((spec) => spec.model),
    DEFAULT_TRIO.map((spec) => spec.model)
  );
});

test("an empty panel array is treated as unset (default trio applies)", () => {
  const config: FusionConfig = {
    version: FUSION_CONFIG_VERSION,
    ensembles: { default: { panel: [] } }
  };
  const effective = resolveEffectiveConfig(config);
  assert.equal(effective.panel.source, "default");
  assert.equal(effective.panel.value.length, DEFAULT_CLOUD_PANEL.length);
});

test("multiple ensembles resolve, each with its own model id, panel, and judge", () => {
  const config: FusionConfig = {
    version: FUSION_CONFIG_VERSION,
    ensembles: {
      default: {
        panel: [{ id: "gpt", model: "gpt-5.5", provider: "openai" }],
        judgeModel: "gpt-5.5"
      },
      deep: {
        panel: [
          { id: "opus", model: "claude-opus-4-8", provider: "anthropic" },
          { id: "gpt", model: "gpt-5.5", provider: "openai" }
        ],
        judgeModel: "claude-opus-4-8",
        synthesizerModel: "claude-opus-4-8"
      }
    }
  };
  const effective = resolveEffectiveConfig(config);
  assert.equal(effective.ensembles.source, "config");
  assert.equal(effective.ensembles.value.length, 2);
  // Session default (`default`) sorts first and supplies the top-level fields.
  assert.deepEqual(effective.defaultEnsemble, { value: "default", source: "default" });
  assert.equal(effective.ensembles.value[0]?.name, "default");
  assert.equal(effective.ensembles.value[0]?.modelId, "fusion-panel");
  assert.equal(effective.ensembles.value[1]?.name, "deep");
  assert.equal(effective.ensembles.value[1]?.modelId, "fusion-deep");
  assert.equal(effective.ensembles.value[1]?.judgeModel, "claude-opus-4-8");
  assert.equal(effective.ensembles.value[1]?.synthesizerModel, "claude-opus-4-8");
  assert.equal(effective.panel.value[0]?.id, "gpt");
});

test("--ensemble selects the session default and receives flag overrides", () => {
  const config: FusionConfig = {
    version: FUSION_CONFIG_VERSION,
    ensembles: {
      default: { panel: [{ id: "gpt", model: "gpt-5.5", provider: "openai" }] },
      deep: {
        panel: [{ id: "opus", model: "claude-opus-4-8", provider: "anthropic" }],
        judgeModel: "claude-opus-4-8"
      }
    }
  };
  const effective = resolveEffectiveConfig(config, { ensemble: "deep", judgeModel: "gpt-5.5" });
  assert.deepEqual(effective.defaultEnsemble, { value: "deep", source: "flag" });
  assert.equal(effective.ensembles.value[0]?.name, "deep");
  // The flag judge override applies to the selected ensemble only.
  assert.deepEqual(effective.judgeModel, { value: "gpt-5.5", source: "flag" });
  assert.equal(effective.panel.value[0]?.id, "opus");

  assert.throws(() => resolveEffectiveConfig(config, { ensemble: "nope" }), /unknown ensemble/);
});

test("reasoning + reasoningModel resolve with full precedence", () => {
  // Defaults: narration on, templated prose (no writer model).
  const defaults = resolveEffectiveConfig(undefined);
  assert.deepEqual(defaults.reasoning, { value: true, source: "default" });
  assert.deepEqual(defaults.reasoningModel, { value: undefined, source: "default" });

  const config: FusionConfig = {
    version: FUSION_CONFIG_VERSION,
    reasoning: true,
    reasoningModel: "mlx-community/Qwen3-1.7B-4bit"
  };
  const fromConfig = resolveEffectiveConfig(config);
  assert.deepEqual(fromConfig.reasoningModel, {
    value: "mlx-community/Qwen3-1.7B-4bit",
    source: "config"
  });

  const fromFlag = resolveEffectiveConfig(config, {
    reasoning: false,
    reasoningModel: "mlx-community/Qwen3-0.6B-4bit"
  });
  assert.deepEqual(fromFlag.reasoning, { value: false, source: "flag" });
  assert.deepEqual(fromFlag.reasoningModel, { value: "mlx-community/Qwen3-0.6B-4bit", source: "flag" });
});

test("prompt overrides are sourced from config, never from a flag", () => {
  const config: FusionConfig = {
    version: FUSION_CONFIG_VERSION,
    prompts: { judge: "CUSTOM JUDGE" }
  };
  const effective = resolveEffectiveConfig(config);
  assert.deepEqual(effective.prompts, { value: { judge: "CUSTOM JUDGE" }, source: "config" });
  assert.deepEqual(resolveEffectiveConfig(undefined).prompts, { value: {}, source: "default" });
});
