/**
 * `fusionkit fusion model` — interactive session model picker.
 */

import { resolve } from "node:path";

import type { RoutingProviderSpec } from "@fusionkit/model-gateway";

import {
  FusionConfigError,
  loadFusionConfig
} from "../fusion-config.js";
import type { FusionConfig, FusionRoutingConfig } from "../fusion-config.js";
import { gitToplevel } from "../fusion/env.js";
import { loadRoutingConfig } from "../fusion/routing.js";
import { writeSessionModelOverride } from "../fusion/session-override.js";
import { fail } from "../shared/errors.js";
import { select, text } from "../ui/prompt.js";
import { SMART_ROUTING_LABEL } from "./fusion-status.js";

const CUSTOM_MODEL = "__custom__";

export type FusionModelOptions = {
  repo?: string;
  homeDir?: string;
  now?: () => Date;
};

type ModelChoice = {
  value: string | null;
  label: string;
};

/**
 * Human-readable label for a routing provider entry.
 */
export function labelRoutingProvider(spec: RoutingProviderSpec): string {
  if (spec.provider === "anthropic" && spec.keyEnv === undefined) {
    return "Claude Code subscription";
  }
  if (spec.provider === "openai" && spec.keyEnv === undefined) {
    return "Codex subscription";
  }
  if (spec.provider === "openrouter") {
    return `OpenRouter/${spec.id}`;
  }
  return spec.id;
}

/**
 * Build model picker choices from routing providers or panel members.
 */
export function buildModelChoices(config: FusionConfig | undefined, routing?: FusionRoutingConfig): ModelChoice[] {
  const choices: ModelChoice[] = [{ value: null, label: SMART_ROUTING_LABEL }];

  const providers = routing?.providers ?? config?.routing?.providers;
  if (providers !== undefined && providers.length > 0) {
    for (const provider of providers) {
      choices.push({ value: provider.id, label: labelRoutingProvider(provider) });
    }
  } else if (config?.panel !== undefined) {
    for (const member of config.panel) {
      choices.push({ value: member.id, label: `${member.id} (${member.model})` });
    }
  }

  choices.push({ value: CUSTOM_MODEL, label: "Custom (enter model ID)" });
  return choices;
}

/**
 * Resolve the display label for a chosen model value.
 */
export function labelForModelChoice(choices: readonly ModelChoice[], value: string | null): string {
  if (value === null) return SMART_ROUTING_LABEL;
  const match = choices.find((choice) => choice.value === value);
  return match?.label ?? value;
}

/**
 * Run `fusionkit fusion model`.
 */
export async function runFusionModel(options: FusionModelOptions = {}): Promise<number> {
  if (!process.stdin.isTTY) {
    fail("fusionkit fusion model requires an interactive terminal");
  }

  const cwd = process.cwd();
  const repoRoot = options.repo !== undefined ? resolve(options.repo) : gitToplevel(cwd);
  if (repoRoot === undefined) {
    fail("not inside a git repository — run from a repo root or pass --repo");
  }

  let config: FusionConfig | undefined;
  try {
    config = loadFusionConfig(repoRoot);
  } catch (error) {
    if (error instanceof FusionConfigError) fail(error.message);
    throw error;
  }

  const routing = loadRoutingConfig(repoRoot);
  const choices = buildModelChoices(config, routing);
  const selected = await select<string | null>({
    message: "Which model for this session?",
    options: choices.map((choice) => ({ value: choice.value, label: choice.label })),
    defaultIndex: 0
  });

  let modelId: string | null;
  if (selected === CUSTOM_MODEL) {
    const custom = await text({ message: "Model ID", defaultValue: "" });
    if (custom.length === 0) {
      fail("model ID cannot be empty");
    }
    modelId = custom;
  } else {
    modelId = selected;
  }

  writeSessionModelOverride(modelId, {
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    ...(options.now !== undefined ? { now: options.now } : {})
  });

  const label = selected === CUSTOM_MODEL ? modelId : labelForModelChoice(choices, modelId);
  console.log(`✅ Active model: ${label}`);
  return 0;
}
