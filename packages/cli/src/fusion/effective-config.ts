import type {
  EnsembleConfig,
  FusionConfig,
  FusionTool,
  OnRateLimitPolicy,
  PromptOverrides
} from "@fusionkit/config";
import { DEFAULT_ENSEMBLE_NAME, FusionConfigError } from "@fusionkit/config";
import { fusionModelId } from "@fusionkit/registry";
import { resolveLayer } from "@velum-labs/routekit-config-core";
import type { ConfigSource, LayeredValue } from "@velum-labs/routekit-config-core";

export type { ConfigSource };
export type Provenance<T> = LayeredValue<T>;

export const DEFAULT_TOOL: FusionTool = "codex";
export const DEFAULT_OBSERVE = false;
export const DEFAULT_ON_RATE_LIMIT: OnRateLimitPolicy = "fusion";
export const DEFAULT_PORTLESS = true;
export const DEFAULT_REASONING = true;

export type EffectiveEnsemble = {
  name: string;
  modelId: string;
  members: string[];
  judge: string;
  synthesizer?: string;
  k?: number;
  prompts: PromptOverrides;
};

export type EffectiveOverrides = {
  tool?: FusionTool;
  ensemble?: string;
  observe?: boolean;
  onRateLimit?: OnRateLimitPolicy;
  portless?: boolean;
  reasoning?: boolean;
};

export type EffectiveFusionConfig = {
  router: Provenance<FusionConfig["router"]>;
  tool: Provenance<FusionTool>;
  ensembles: Provenance<EffectiveEnsemble[]>;
  defaultEnsemble: Provenance<string>;
  observe: Provenance<boolean>;
  onRateLimit: Provenance<OnRateLimitPolicy>;
  portless: Provenance<boolean>;
  reasoning: Provenance<boolean>;
  budgetUsd: Provenance<number | undefined>;
  panelTrust: Provenance<FusionConfig["panelTrust"]>;
  subagents: Provenance<boolean>;
  port: Provenance<number | null | undefined>;
  k: Provenance<number | undefined>;
  prompts: Provenance<PromptOverrides>;
};

export function configDefaultEnsembleName(
  config: FusionConfig | undefined
): string | undefined {
  if (config === undefined) return undefined;
  if (config.defaultEnsemble !== undefined) return config.defaultEnsemble;
  const names = Object.keys(config.ensembles);
  return names.includes(DEFAULT_ENSEMBLE_NAME)
    ? DEFAULT_ENSEMBLE_NAME
    : names[0];
}

function effectiveEnsemble(
  name: string,
  ensemble: EnsembleConfig,
  defaultK?: number
): EffectiveEnsemble {
  return {
    name,
    modelId: fusionModelId(name),
    members: [...ensemble.members],
    judge: ensemble.judge,
    ...(ensemble.synthesizer !== undefined
      ? { synthesizer: ensemble.synthesizer }
      : {}),
    ...((ensemble.k ?? defaultK) !== undefined
      ? { k: ensemble.k ?? defaultK }
      : {}),
    prompts: ensemble.prompts ?? {}
  };
}

export function resolveEffectiveConfig(
  config: FusionConfig | undefined,
  overrides: EffectiveOverrides = {}
): EffectiveFusionConfig {
  if (config === undefined) {
    throw new FusionConfigError(
      "no FusionKit v4 config found; run `fusionkit init`"
    );
  }
  const defaultName = resolveLayer(
    overrides.ensemble,
    config.defaultEnsemble,
    configDefaultEnsembleName(config) ?? DEFAULT_ENSEMBLE_NAME
  );
  if (config.ensembles[defaultName.value] === undefined) {
    throw new FusionConfigError(
      `unknown ensemble ${JSON.stringify(defaultName.value)}`
    );
  }
  const ensembles = Object.entries(config.ensembles).map(([name, ensemble]) =>
    effectiveEnsemble(name, ensemble, config.k)
  );
  ensembles.sort((left, right) =>
    left.name === defaultName.value
      ? -1
      : right.name === defaultName.value
        ? 1
        : 0
  );
  const selected = ensembles[0] as EffectiveEnsemble;
  return {
    router: { value: config.router, source: "config" },
    tool: resolveLayer(overrides.tool, config.tool, DEFAULT_TOOL),
    ensembles: { value: ensembles, source: "config" },
    defaultEnsemble: defaultName,
    observe: resolveLayer(overrides.observe, config.observe, DEFAULT_OBSERVE),
    onRateLimit: resolveLayer(
      overrides.onRateLimit,
      config.onRateLimit,
      DEFAULT_ON_RATE_LIMIT
    ),
    portless: resolveLayer(
      overrides.portless,
      config.portless,
      DEFAULT_PORTLESS
    ),
    reasoning: resolveLayer(
      overrides.reasoning,
      config.reasoning,
      DEFAULT_REASONING
    ),
    budgetUsd: {
      value: config.budgetUsd,
      source: config.budgetUsd === undefined ? "default" : "config"
    },
    panelTrust: {
      value: config.panelTrust,
      source: config.panelTrust === undefined ? "default" : "config"
    },
    subagents: resolveLayer(undefined, config.subagents, false),
    port: {
      value: config.port,
      source: config.port === undefined ? "default" : "config"
    },
    k: {
      value: config.k,
      source: config.k === undefined ? "default" : "config"
    },
    prompts: {
      value: selected.prompts,
      source: Object.keys(selected.prompts).length > 0 ? "config" : "default"
    }
  };
}
