/**
 * The one place that resolves the *effective* fusion configuration and records
 * where each value came from. There is a single config source of truth for
 * users — the committed `.fusionkit/fusion.json` (+ `.fusionkit/prompts/*.md`) —
 * and the Python router YAML is purely derived from it (see
 * {@link exportRouterYaml}). Run-time precedence is:
 *
 *     explicit CLI flag  >  .fusionkit/fusion.json  >  built-in default
 *
 * `resolveEffectiveConfig` mirrors that precedence and tags each field with its
 * `source`, which `fusionkit config show` renders for provenance. The default
 * panel is hardware-shaped: the local MLX trio when `local` is effectively on,
 * the decorrelated three-vendor cloud trio otherwise.
 */
import type { OnRateLimitPolicy } from "@fusionkit/model-gateway";

import type { FusionConfig, PromptOverrides } from "../fusion-config.js";

import { DEFAULT_CLOUD_PANEL, DEFAULT_TRIO } from "./env.js";
import type { FusionTool, PanelModelSpec } from "./env.js";

/** Where an effective value came from, in precedence order (flag wins). */
export type ConfigSource = "flag" | "config" | "default";

/** A resolved value plus the layer that supplied it. */
export type Provenance<T> = { value: T; source: ConfigSource };

/** Built-in defaults, shared with the run path so `config show` never lies. */
export const DEFAULT_TOOL: FusionTool = "codex";
export const DEFAULT_LOCAL = false;
export const DEFAULT_OBSERVE = false;
export const DEFAULT_ON_RATE_LIMIT: OnRateLimitPolicy = "fusion";
export const DEFAULT_PORTLESS = true;
export const DEFAULT_REASONING = true;

/**
 * Explicit CLI-flag overrides (the top precedence layer). Only fields the user
 * actually passed should be set; `undefined` falls through to the config file,
 * then to the built-in default.
 */
export type EffectiveOverrides = {
  tool?: FusionTool;
  local?: boolean;
  panel?: PanelModelSpec[];
  judgeModel?: string;
  observe?: boolean;
  onRateLimit?: OnRateLimitPolicy;
  portless?: boolean;
  reasoning?: boolean;
  reasoningModel?: string;
};

export type EffectiveFusionConfig = {
  tool: Provenance<FusionTool>;
  local: Provenance<boolean>;
  panel: Provenance<PanelModelSpec[]>;
  judgeModel: Provenance<string>;
  observe: Provenance<boolean>;
  onRateLimit: Provenance<OnRateLimitPolicy>;
  portless: Provenance<boolean>;
  reasoning: Provenance<boolean>;
  /** The local narration-writer model; undefined = templated prose. */
  reasoningModel: Provenance<string | undefined>;
  prompts: Provenance<PromptOverrides>;
};

/** flag > config > default, tagging the winning layer. */
function pick<T>(flag: T | undefined, file: T | undefined, fallback: T): Provenance<T> {
  if (flag !== undefined) return { value: flag, source: "flag" };
  if (file !== undefined) return { value: file, source: "config" };
  return { value: fallback, source: "default" };
}

/**
 * Resolve the effective config for a repo from its loaded `.fusionkit` config
 * (or `undefined` when none exists) and any explicit CLI-flag overrides. The
 * default panel depends on the *effective* `local`, and the default judge is the
 * first effective panel member's model — so the three are resolved in order.
 */
export function resolveEffectiveConfig(
  config: FusionConfig | undefined,
  overrides: EffectiveOverrides = {}
): EffectiveFusionConfig {
  const tool = pick(overrides.tool, config?.tool, DEFAULT_TOOL);
  const local = pick(overrides.local, config?.local, DEFAULT_LOCAL);

  const defaultPanel: PanelModelSpec[] = local.value
    ? DEFAULT_TRIO.map((spec) => ({ ...spec }))
    : DEFAULT_CLOUD_PANEL.map((spec) => ({ ...spec }));
  // An empty `panel: []` in the file is treated as "unset" so the default trio
  // still applies (matching the run path's `config.panel.length > 0` guard).
  const filePanel =
    config?.panel !== undefined && config.panel.length > 0
      ? config.panel.map((spec) => ({ ...spec }))
      : undefined;
  const panel = pick(overrides.panel, filePanel, defaultPanel);

  const defaultJudge = panel.value[0]?.model ?? "";
  const judgeModel = pick(overrides.judgeModel, config?.judgeModel, defaultJudge);

  const observe = pick(overrides.observe, config?.observe, DEFAULT_OBSERVE);
  const onRateLimit = pick(overrides.onRateLimit, config?.onRateLimit, DEFAULT_ON_RATE_LIMIT);
  const portless = pick(overrides.portless, config?.portless, DEFAULT_PORTLESS);
  const reasoning = pick(overrides.reasoning, config?.reasoning, DEFAULT_REASONING);
  const reasoningModel = pick<string | undefined>(
    overrides.reasoningModel,
    config?.reasoningModel,
    undefined
  );
  // Prompt overrides only ever come from `.fusionkit/prompts/*.md` (no flag).
  const prompts = pick<PromptOverrides>(undefined, config?.prompts, {});

  return { tool, local, panel, judgeModel, observe, onRateLimit, portless, reasoning, reasoningModel, prompts };
}
