/**
 * The one place that resolves the *effective* fusion configuration and records
 * where each value came from. There is a single config source of truth for
 * users — the committed `.fusionkit/fusion.json` (+ `.fusionkit/prompts/`) —
 * and the Python router YAML is purely derived from it (see
 * {@link exportRouterYaml}). Run-time precedence is:
 *
 *     explicit CLI flag  >  .fusionkit/fusion.json  >  built-in default
 *
 * `resolveEffectiveConfig` mirrors that precedence and tags each field with its
 * `source`, which `fusionkit config show` renders for provenance. A repo may
 * define multiple named ensembles; the selected ensemble (the `--ensemble`
 * flag, then `defaultEnsemble`, then `default`) supplies the top-level
 * `panel`/`judgeModel`/`prompts`, while `ensembles` lists every resolved
 * ensemble (each registered as its own `fusion-<name>` model). The default
 * panel is hardware-shaped: the local MLX trio when `local` is effectively on,
 * the decorrelated three-vendor cloud trio otherwise.
 */
import type { OnRateLimitPolicy } from "@fusionkit/model-gateway";
import { DEFAULT_ENSEMBLE_NAME, fusionModelId } from "@fusionkit/registry";

import { FusionConfigError } from "../fusion-config.js";
import type { EnsembleConfig, FusionConfig, PromptOverrides } from "../fusion-config.js";

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

/** One fully resolved named ensemble. */
export type EffectiveEnsemble = {
  name: string;
  /** The advertised gateway model id (`fusion-panel` / `fusion-<name>`). */
  modelId: string;
  panel: PanelModelSpec[];
  /** The judge model name; empty when the panel is empty. */
  judgeModel: string;
  synthesizerModel?: string;
  prompts: PromptOverrides;
};

/**
 * Explicit CLI-flag overrides (the top precedence layer). Only fields the user
 * actually passed should be set; `undefined` falls through to the config file,
 * then to the built-in default. `panel`/`judgeModel` overrides apply to the
 * *selected* ensemble (`ensemble`, then the config's `defaultEnsemble`).
 */
export type EffectiveOverrides = {
  tool?: FusionTool;
  local?: boolean;
  ensemble?: string;
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
  /** Every resolved ensemble, the selected/default one first. */
  ensembles: Provenance<EffectiveEnsemble[]>;
  /** The selected/default ensemble's name. */
  defaultEnsemble: Provenance<string>;
  /** The selected ensemble's panel (kept for single-ensemble consumers). */
  panel: Provenance<PanelModelSpec[]>;
  /** The selected ensemble's judge model. */
  judgeModel: Provenance<string>;
  observe: Provenance<boolean>;
  onRateLimit: Provenance<OnRateLimitPolicy>;
  portless: Provenance<boolean>;
  reasoning: Provenance<boolean>;
  /** The narration-writer model (panel member, provider/model, or local MLX); undefined = templated prose. */
  reasoningModel: Provenance<string | undefined>;
  /** The selected ensemble's prompt overrides. */
  prompts: Provenance<PromptOverrides>;
};

/** flag > config > default, tagging the winning layer. */
function pick<T>(flag: T | undefined, file: T | undefined, fallback: T): Provenance<T> {
  if (flag !== undefined) return { value: flag, source: "flag" };
  if (file !== undefined) return { value: file, source: "config" };
  return { value: fallback, source: "default" };
}

/** The config's default ensemble name: `defaultEnsemble`, else `default`, else first. */
export function configDefaultEnsembleName(config: FusionConfig | undefined): string | undefined {
  if (config?.ensembles === undefined) return undefined;
  if (config.defaultEnsemble !== undefined) return config.defaultEnsemble;
  const names = Object.keys(config.ensembles);
  if (names.length === 0) return undefined;
  return names.includes(DEFAULT_ENSEMBLE_NAME) ? DEFAULT_ENSEMBLE_NAME : names[0];
}

/** Resolve one configured ensemble against the hardware-shaped default panel. */
function resolveEnsemble(
  name: string,
  ensemble: EnsembleConfig,
  defaultPanel: readonly PanelModelSpec[]
): EffectiveEnsemble {
  const panel =
    ensemble.panel !== undefined && ensemble.panel.length > 0
      ? ensemble.panel.map((spec) => ({ ...spec }))
      : defaultPanel.map((spec) => ({ ...spec }));
  return {
    name,
    modelId: fusionModelId(name),
    panel,
    judgeModel: ensemble.judgeModel ?? panel[0]?.model ?? "",
    ...(ensemble.synthesizerModel !== undefined ? { synthesizerModel: ensemble.synthesizerModel } : {}),
    prompts: ensemble.prompts ?? {}
  };
}

/**
 * Resolve the effective config for a repo from its loaded `.fusionkit` config
 * (or `undefined` when none exists) and any explicit CLI-flag overrides. The
 * default panel depends on the *effective* `local`, and the default judge is the
 * first effective panel member's model — so the three are resolved in order.
 * Panel/judge flag overrides apply to the selected ensemble only.
 */
export function resolveEffectiveConfig(
  config: FusionConfig | undefined,
  overrides: EffectiveOverrides = {}
): EffectiveFusionConfig {
  const tool = pick(overrides.tool, config?.tool, DEFAULT_TOOL);
  const local = pick(overrides.local, config?.local, DEFAULT_LOCAL);

  const defaultPanel: readonly PanelModelSpec[] = local.value ? DEFAULT_TRIO : DEFAULT_CLOUD_PANEL;

  // Resolve the ensemble map: configured ensembles, or a single implicit
  // `default` built from the hardware-shaped trio.
  const configured = config?.ensembles;
  const hasConfigured = configured !== undefined && Object.keys(configured).length > 0;
  // Only an explicit `defaultEnsemble` is config-sourced; a derived first name
  // (`default`, else the first key) is a default-layer fallback.
  const defaultEnsemble = pick(
    overrides.ensemble,
    config?.defaultEnsemble,
    configDefaultEnsembleName(config) ?? DEFAULT_ENSEMBLE_NAME
  );
  if (hasConfigured && configured[defaultEnsemble.value] === undefined) {
    throw new FusionConfigError(
      `unknown ensemble ${JSON.stringify(defaultEnsemble.value)} (have: ${Object.keys(configured).join(", ")})`
    );
  }

  let ensembles: EffectiveEnsemble[];
  if (hasConfigured) {
    ensembles = Object.entries(configured).map(([name, ensemble]) =>
      resolveEnsemble(name, ensemble, defaultPanel)
    );
  } else {
    ensembles = [
      resolveEnsemble(
        DEFAULT_ENSEMBLE_NAME,
        { ...(config?.prompts !== undefined ? { prompts: config.prompts } : {}) },
        defaultPanel
      )
    ];
  }
  // Selected/default ensemble first (stable order for registration/pickers).
  ensembles.sort((a, b) =>
    a.name === defaultEnsemble.value ? -1 : b.name === defaultEnsemble.value ? 1 : 0
  );
  const selected = ensembles[0] as EffectiveEnsemble;

  // Flag panel/judge overrides apply to the selected ensemble.
  if (overrides.panel !== undefined) {
    selected.panel = overrides.panel.map((spec) => ({ ...spec }));
    if (overrides.judgeModel === undefined) {
      selected.judgeModel = selected.panel[0]?.model ?? "";
    }
  }
  if (overrides.judgeModel !== undefined) selected.judgeModel = overrides.judgeModel;

  const selectedFromConfig = hasConfigured
    ? (configured[selected.name] as EnsembleConfig)
    : undefined;
  const panel: Provenance<PanelModelSpec[]> = {
    value: selected.panel,
    source:
      overrides.panel !== undefined
        ? "flag"
        : selectedFromConfig?.panel !== undefined && selectedFromConfig.panel.length > 0
          ? "config"
          : "default"
  };
  const judgeModel: Provenance<string> = {
    value: selected.judgeModel,
    source:
      overrides.judgeModel !== undefined
        ? "flag"
        : selectedFromConfig?.judgeModel !== undefined
          ? "config"
          : "default"
  };
  const ensemblesProvenance: Provenance<EffectiveEnsemble[]> = {
    value: ensembles,
    source: hasConfigured ? "config" : "default"
  };

  const observe = pick(overrides.observe, config?.observe, DEFAULT_OBSERVE);
  const onRateLimit = pick(overrides.onRateLimit, config?.onRateLimit, DEFAULT_ON_RATE_LIMIT);
  const portless = pick(overrides.portless, config?.portless, DEFAULT_PORTLESS);
  const reasoning = pick(overrides.reasoning, config?.reasoning, DEFAULT_REASONING);
  const reasoningModel = pick<string | undefined>(
    overrides.reasoningModel,
    config?.reasoningModel,
    undefined
  );
  // Prompt overrides only ever come from `.fusionkit/prompts/` (no flag).
  const prompts: Provenance<PromptOverrides> = {
    value: selected.prompts,
    source: Object.keys(selected.prompts).length > 0 ? "config" : "default"
  };

  return {
    tool,
    local,
    ensembles: ensemblesProvenance,
    defaultEnsemble,
    panel,
    judgeModel,
    observe,
    onRateLimit,
    portless,
    reasoning,
    reasoningModel,
    prompts
  };
}
