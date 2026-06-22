/**
 * Deterministic routing onboarding for `fusionkit init`.
 *
 * Inspects detected subscriptions and API-key env vars, then proposes a
 * {@link FusionRoutingConfig} without calling a model. Used as the fallback when
 * MLX is unavailable or the AI assistant fails validation.
 */
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_CLAUDE_SUB_MODEL,
  detectSubscription
} from "./subscriptions.js";
import type { SubscriptionStatus } from "./subscriptions.js";
import type { FusionRoutingConfig } from "../fusion-config.js";
import {
  ROUTING_PROVIDER_KINDS,
  parseScenarioRoutes,
  RoutingConfigError
} from "@fusionkit/model-gateway";
import type { RoutingProviderSpec } from "@fusionkit/model-gateway";

/** Env vars checked for API-key routing providers. */
export const ROUTING_API_KEY_ENVS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY"
] as const;

export type RoutingApiKeyEnv = (typeof ROUTING_API_KEY_ENVS)[number];

/** One-line descriptions of the five routing scenarios (for AI + docs). */
export const ROUTING_SCENARIO_DESCRIPTIONS: Readonly<Record<string, string>> = {
  default: "Standard requests that do not match a specialised scenario",
  background: "Low-stakes / background agent work — optimise for speed and cost",
  longContext: "Prompts exceeding longContextThreshold tokens (default 60,000)",
  reasoning: "Extended thinking, reasoning_effort, or reasoning model hints",
  webSearch: "Requests that include web search or fetch tools"
};

/** Supported routing provider kinds and their default key env vars. */
export const ROUTING_PROVIDER_KEY_ENVS: Readonly<
  Record<string, RoutingApiKeyEnv | undefined>
> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  groq: "GROQ_API_KEY",
  "google-gemini": "GEMINI_API_KEY"
};

/** Snapshot of subscription + API-key availability for routing proposals. */
export type RoutingOnboardingDetection = {
  subscriptions: {
    "claude-code": SubscriptionStatus;
    codex: SubscriptionStatus;
  };
  apiKeys: Record<RoutingApiKeyEnv, boolean>;
  /** Local MLX panel model repo ids when configured. */
  localPanelModels?: string[];
  /** Ollama probe result from init preflight. */
  ollama?: {
    reachable: boolean;
    models: string[];
  };
};

/** Thrown when onboarding cannot build or validate a routing config. */
export class RoutingOnboardingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingOnboardingError";
  }
}

type RouteCandidate = {
  target: string;
  provider?: RoutingProviderSpec;
  available: (detection: RoutingOnboardingDetection) => boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function subscriptionReady(status: SubscriptionStatus): boolean {
  return status.available && !status.expired;
}

function hasKey(detection: RoutingOnboardingDetection, env: RoutingApiKeyEnv): boolean {
  return detection.apiKeys[env] === true;
}

function anthropicProvider(
  id: string,
  detection: RoutingOnboardingDetection
): RoutingProviderSpec | undefined {
  if (subscriptionReady(detection.subscriptions["claude-code"])) {
    return { id, provider: "anthropic" };
  }
  if (hasKey(detection, "ANTHROPIC_API_KEY")) {
    return { id, provider: "anthropic", keyEnv: "ANTHROPIC_API_KEY" };
  }
  return undefined;
}

function openaiProvider(
  id: string,
  detection: RoutingOnboardingDetection
): RoutingProviderSpec | undefined {
  if (subscriptionReady(detection.subscriptions.codex)) {
    return { id, provider: "openai" };
  }
  if (hasKey(detection, "OPENAI_API_KEY")) {
    return { id, provider: "openai", keyEnv: "OPENAI_API_KEY" };
  }
  return undefined;
}

function keyedProvider(
  id: string,
  provider: RoutingProviderSpec["provider"],
  keyEnv: RoutingApiKeyEnv,
  detection: RoutingOnboardingDetection
): RoutingProviderSpec | undefined {
  if (!hasKey(detection, keyEnv)) return undefined;
  return { id, provider, keyEnv };
}

/**
 * Collect subscription and API-key presence from the environment (no secrets).
 */
export function detectRoutingContext(
  env: Record<string, string | undefined> = process.env
): RoutingOnboardingDetection {
  const apiKeys = Object.fromEntries(
    ROUTING_API_KEY_ENVS.map((key) => [key, (env[key] ?? "").length > 0])
  ) as Record<RoutingApiKeyEnv, boolean>;
  return {
    subscriptions: {
      "claude-code": detectSubscription("claude-code"),
      codex: detectSubscription("codex")
    },
    apiKeys
  };
}

function pickScenarioTarget(
  candidates: readonly RouteCandidate[],
  detection: RoutingOnboardingDetection
): { target: string; provider?: RoutingProviderSpec } | undefined {
  for (const candidate of candidates) {
    if (!candidate.available(detection)) continue;
    return { target: candidate.target, ...(candidate.provider !== undefined ? { provider: candidate.provider } : {}) };
  }
  return undefined;
}

function providerFor(
  providers: Map<string, RoutingProviderSpec>,
  spec: RoutingProviderSpec | undefined
): void {
  if (spec === undefined) return;
  if (!providers.has(spec.id)) providers.set(spec.id, spec);
}

/**
 * Pure deterministic routing proposal based on detected auth (see `docs/phase-2-providers.md` §3).
 */
export function proposeDeterministicRouting(
  detection: RoutingOnboardingDetection
): FusionRoutingConfig {
  const providers = new Map<string, RoutingProviderSpec>();

  const defaultPick = pickScenarioTarget(
    [
      {
        target: `claude-sub,${DEFAULT_CLAUDE_SUB_MODEL}`,
        provider: anthropicProvider("claude-sub", detection),
        available: (d) => anthropicProvider("claude-sub", d) !== undefined
      },
      {
        target: `openrouter,anthropic/claude-sonnet-4.6`,
        provider: keyedProvider("openrouter", "openrouter", "OPENROUTER_API_KEY", detection),
        available: (d) => hasKey(d, "OPENROUTER_API_KEY")
      },
      {
        target: `gemini,gemini-2.5-flash`,
        provider: keyedProvider("gemini", "google-gemini", "GEMINI_API_KEY", detection),
        available: (d) => hasKey(d, "GEMINI_API_KEY")
      },
      {
        target: `openai,gpt-4o`,
        provider: keyedProvider("openai", "openai", "OPENAI_API_KEY", detection),
        available: (d) => hasKey(d, "OPENAI_API_KEY")
      },
      {
        target: `groq,openai/gpt-oss-120b`,
        provider: keyedProvider("groq", "groq", "GROQ_API_KEY", detection),
        available: (d) => hasKey(d, "GROQ_API_KEY")
      },
      {
        target: `deepseek,deepseek-v4-flash`,
        provider: keyedProvider("deepseek", "deepseek", "DEEPSEEK_API_KEY", detection),
        available: (d) => hasKey(d, "DEEPSEEK_API_KEY")
      }
    ],
    detection
  );

  if (defaultPick === undefined) {
    throw new RoutingOnboardingError(
      "no subscriptions or API keys detected — set at least one provider key or log in to Claude Code / Codex"
    );
  }
  providerFor(providers, defaultPick.provider);

  const backgroundPick = pickScenarioTarget(
    [
      ...(detection.localPanelModels?.[0] !== undefined
        ? [
            {
              target: `local-mlx,${detection.localPanelModels[0]}`,
              provider: { id: "local-mlx", provider: "mlx" as const, model: detection.localPanelModels[0] },
              available: () => true
            }
          ]
        : []),
      ...(detection.ollama?.reachable === true && detection.ollama.models[0] !== undefined
        ? [
            {
              target: `local-ollama,${detection.ollama.models[0]}`,
              provider: { id: "local-ollama", provider: "ollama" as const },
              available: () => true
            }
          ]
        : []),
      {
        target: `groq,llama-3.1-8b-instant`,
        provider: keyedProvider("groq", "groq", "GROQ_API_KEY", detection),
        available: (d) => hasKey(d, "GROQ_API_KEY")
      },
      {
        target: `deepseek,deepseek-v4-flash`,
        provider: keyedProvider("deepseek", "deepseek", "DEEPSEEK_API_KEY", detection),
        available: (d) => hasKey(d, "DEEPSEEK_API_KEY")
      },
      {
        target: `gemini,gemini-2.5-flash-lite`,
        provider: keyedProvider("gemini", "google-gemini", "GEMINI_API_KEY", detection),
        available: (d) => hasKey(d, "GEMINI_API_KEY")
      },
      {
        target: `openrouter,google/gemini-2.5-flash`,
        provider: keyedProvider("openrouter", "openrouter", "OPENROUTER_API_KEY", detection),
        available: (d) => hasKey(d, "OPENROUTER_API_KEY")
      },
      { target: defaultPick.target, available: () => true }
    ],
    detection
  );

  const longContextPick = pickScenarioTarget(
    [
      {
        target: `gemini,gemini-2.5-pro`,
        provider: keyedProvider("gemini", "google-gemini", "GEMINI_API_KEY", detection),
        available: (d) => hasKey(d, "GEMINI_API_KEY")
      },
      {
        target: `openrouter,google/gemini-2.5-pro`,
        provider: keyedProvider("openrouter", "openrouter", "OPENROUTER_API_KEY", detection),
        available: (d) => hasKey(d, "OPENROUTER_API_KEY")
      },
      {
        target: `openrouter,anthropic/claude-sonnet-4.6`,
        provider: keyedProvider("openrouter", "openrouter", "OPENROUTER_API_KEY", detection),
        available: (d) => hasKey(d, "OPENROUTER_API_KEY")
      },
      {
        target: `claude-sub,${DEFAULT_CLAUDE_SUB_MODEL}`,
        provider: anthropicProvider("claude-sub", detection),
        available: (d) => anthropicProvider("claude-sub", d) !== undefined
      },
      { target: defaultPick.target, available: () => true }
    ],
    detection
  );

  const reasoningPick = pickScenarioTarget(
    [
      {
        target: `deepseek,deepseek-v4-pro`,
        provider: keyedProvider("deepseek", "deepseek", "DEEPSEEK_API_KEY", detection),
        available: (d) => hasKey(d, "DEEPSEEK_API_KEY")
      },
      {
        target: `openrouter,anthropic/claude-sonnet-4.6`,
        provider: keyedProvider("openrouter", "openrouter", "OPENROUTER_API_KEY", detection),
        available: (d) => hasKey(d, "OPENROUTER_API_KEY")
      },
      {
        target: `codex-sub,${DEFAULT_CODEX_MODEL}`,
        provider: openaiProvider("codex-sub", detection),
        available: (d) => openaiProvider("codex-sub", d) !== undefined
      },
      {
        target: `claude-sub,claude-opus-4-5`,
        provider: anthropicProvider("claude-sub", detection),
        available: (d) => anthropicProvider("claude-sub", d) !== undefined
      },
      { target: defaultPick.target, available: () => true }
    ],
    detection
  );

  const webSearchPick = pickScenarioTarget(
    [
      {
        target: `openrouter,anthropic/claude-sonnet-4.6`,
        provider: keyedProvider("openrouter", "openrouter", "OPENROUTER_API_KEY", detection),
        available: (d) => hasKey(d, "OPENROUTER_API_KEY")
      },
      {
        target: `gemini,gemini-2.5-flash`,
        provider: keyedProvider("gemini", "google-gemini", "GEMINI_API_KEY", detection),
        available: (d) => hasKey(d, "GEMINI_API_KEY")
      },
      {
        target: `groq,groq/compound`,
        provider: keyedProvider("groq", "groq", "GROQ_API_KEY", detection),
        available: (d) => hasKey(d, "GROQ_API_KEY")
      },
      { target: defaultPick.target, available: () => true }
    ],
    detection
  );

  for (const pick of [backgroundPick, longContextPick, reasoningPick, webSearchPick]) {
    if (pick !== undefined) providerFor(providers, pick.provider);
  }

  const routes = {
    default: defaultPick.target,
    ...(backgroundPick !== undefined ? { background: backgroundPick.target } : {}),
    ...(longContextPick !== undefined ? { longContext: longContextPick.target } : {}),
    longContextThreshold: 60_000,
    ...(reasoningPick !== undefined ? { reasoning: reasoningPick.target } : {}),
    ...(webSearchPick !== undefined ? { webSearch: webSearchPick.target } : {})
  };

  return finalizeRoutingConfig(routes, [...providers.values()]);
}

function finalizeRoutingConfig(
  routes: Record<string, unknown>,
  providers: readonly RoutingProviderSpec[]
): FusionRoutingConfig {
  if (providers.length === 0) {
    throw new RoutingOnboardingError("routing.providers must be a non-empty array");
  }
  for (const [index, spec] of providers.entries()) {
    if (spec.id.length === 0) {
      throw new RoutingOnboardingError(`routing.providers[${index}].id must be a non-empty string`);
    }
    if (!(ROUTING_PROVIDER_KINDS as readonly string[]).includes(spec.provider)) {
      throw new RoutingOnboardingError(
        `routing.providers[${index}].provider must be one of ${ROUTING_PROVIDER_KINDS.join(", ")}`
      );
    }
  }
  try {
    const parsedRoutes = parseScenarioRoutes(routes, "routing-onboarding");
    return { routes: parsedRoutes, providers: [...providers] };
  } catch (error) {
    if (error instanceof RoutingConfigError) {
      throw new RoutingOnboardingError(error.message);
    }
    throw error;
  }
}

/**
 * Parse and validate a raw routing proposal (from AI or manual edit).
 *
 * @throws {@link RoutingOnboardingError} when validation fails.
 */
export function validateRoutingProposal(raw: unknown, source: string): FusionRoutingConfig {
  if (!isRecord(raw)) {
    throw new RoutingOnboardingError(`${source}: routing must be a JSON object`);
  }
  const routesRaw = isRecord(raw.routes) ? raw.routes : raw;
  const providersRaw = raw.providers;
  if (!Array.isArray(providersRaw) || providersRaw.length === 0) {
    throw new RoutingOnboardingError(`${source}: routing.providers must be a non-empty array`);
  }
  const providers: RoutingProviderSpec[] = [];
  for (const [index, entry] of providersRaw.entries()) {
    if (!isRecord(entry)) {
      throw new RoutingOnboardingError(`${source}: routing.providers[${index}] must be an object`);
    }
    const id = entry.id;
    const provider = entry.provider;
    if (typeof id !== "string" || id.length === 0) {
      throw new RoutingOnboardingError(`${source}: routing.providers[${index}].id must be a non-empty string`);
    }
    if (typeof provider !== "string" || !(ROUTING_PROVIDER_KINDS as readonly string[]).includes(provider)) {
      throw new RoutingOnboardingError(
        `${source}: routing.providers[${index}].provider must be one of ${ROUTING_PROVIDER_KINDS.join(", ")}`
      );
    }
    const spec: RoutingProviderSpec = { id, provider: provider as RoutingProviderSpec["provider"] };
    if (entry.baseUrl !== undefined) {
      if (typeof entry.baseUrl !== "string" || entry.baseUrl.length === 0) {
        throw new RoutingOnboardingError(`${source}: routing.providers[${index}].baseUrl must be a non-empty string`);
      }
      spec.baseUrl = entry.baseUrl;
    }
    if (entry.keyEnv !== undefined) {
      if (typeof entry.keyEnv !== "string" || entry.keyEnv.length === 0) {
        throw new RoutingOnboardingError(`${source}: routing.providers[${index}].keyEnv must be a non-empty string`);
      }
      spec.keyEnv = entry.keyEnv;
    }
    if (entry.model !== undefined) {
      if (typeof entry.model !== "string" || entry.model.length === 0) {
        throw new RoutingOnboardingError(`${source}: routing.providers[${index}].model must be a non-empty string`);
      }
      spec.model = entry.model;
    }
    providers.push(spec);
  }
  try {
    const routes = parseScenarioRoutes(routesRaw, source);
    return { routes, providers };
  } catch (error) {
    if (error instanceof RoutingConfigError) {
      throw new RoutingOnboardingError(error.message);
    }
    throw error;
  }
}

/**
 * Format a routing section for display (pretty JSON, no secrets).
 */
export function formatRoutingSection(config: FusionRoutingConfig): string {
  return JSON.stringify({ routing: config }, null, 2);
}
