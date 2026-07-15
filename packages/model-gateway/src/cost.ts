/**
 * Cost + token metering for the fusion gateway (WS7 — trust & cost).
 *
 * The gateway sees a `usage` block on every turn that crosses its boundary: the
 * vendor's chat completion for a native passthrough turn, and the
 * judge/synthesis step's completion for a fused turn. This module turns that
 * usage plus a per-model price into a per-turn dollar cost, and accumulates a
 * running per-session total.
 *
 * Pricing source. A small built-in table ({@link DEFAULT_MODEL_PRICING}) covers
 * the default cloud panel (and the judge that synthesises it); the gateway can
 * extend/override it per model (e.g. from a richer config). Where no price is
 * known, the turn's tokens are still counted and the cost is flagged
 * `unknownCost` rather than silently reported as $0 — the same "clearly mark
 * unknown" discipline FusionKit's Python `provider_metadata` uses.
 *
 * Scope. The Node gateway meters stage-aware calls that cross the FusionKit
 * contract: panel candidates, judge/synthesis, passthrough, and local compute
 * estimates. Provider-reported spend (for example OpenRouter generation
 * metadata) wins; configured/static pricing is treated as an estimate fallback.
 */
import { DEFAULT_MODEL_PRICING as REGISTRY_MODEL_PRICING, PRICING_ALIASES } from "@routekit/registry";
import { randomId } from "@fusionkit/runtime-utils";

import { decodeBufferedSse } from "./sse/parse.js";

/** USD price for a model, per 1,000,000 tokens. */
export type ModelPricing = {
  inputPer1mTokens: number;
  outputPer1mTokens: number;
  /** ISO 4217 currency; defaults to USD. */
  currency?: string;
};

/** Optional local-compute pricing/usage for a model call. */
export type LocalComputeUsage = {
  /** Active generation wall time. Prefer this over server uptime for cost estimates. */
  activeInferenceMs?: number;
  /** Cold-load time, recorded separately so callers can choose an amortization policy. */
  loadMs?: number;
  /** Time the local server was held up for this call/session, when known. */
  serverUptimeMs?: number;
  tokensPerSecond?: number;
  modelRepo?: string;
  deviceKind?: string;
  /** Optional operator-defined hourly rate for local compute estimates. */
  usdPerDeviceHour?: number;
  /** Derived estimate from activeInferenceMs and usdPerDeviceHour. */
  estimatedCostUsd?: number;
};

export type LocalComputePricing = {
  usdPerDeviceHour?: number;
};

export type ProviderCostMetadata = {
  source: "provider" | "estimate";
  costUsd?: number;
  generationId?: string;
  providerName?: string;
  upstreamInferenceCost?: number;
  cacheDiscount?: number;
  lookupStatus?: string;
  tokensPrompt?: number;
  tokensCompletion?: number;
  nativeTokensPrompt?: number;
  nativeTokensCompletion?: number;
};

/** Prompt / completion / total token counts parsed from a `usage` block. */
export type TokenUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type CostStage = "panel" | "judge_synth" | "passthrough" | "narrator" | "local";

/** The cost of a single metered turn. */
export type TurnCost = {
  model: string;
  usage: TokenUsage;
  /** Resolved USD cost, or `undefined` when usage or pricing is unknown. */
  costUsd?: number;
  /** Token-priced provider spend. Local compute estimates are kept separate. */
  providerCostUsd?: number;
  /** Local compute estimate, when a local hourly rate is configured. */
  localComputeCostUsd?: number;
  unknownUsage: boolean;
  unknownCost: boolean;
  /** True when only prompt or completion tokens were available for pricing. */
  partialUsage?: boolean;
  currency: string;
};

export type CostLedgerEntry = TurnCost & {
  entryId: string;
  stage: CostStage;
  recordedAt: number;
  turn?: number;
  provider?: string;
  endpointId?: string;
  latencyMs?: number;
  providerCost?: ProviderCostMetadata;
  localCompute?: LocalComputeUsage;
};

/** The running per-session accumulation persisted with the session header. */
export type SessionCost = {
  totalUsd: number;
  /** Token-priced provider spend only; absent on sessions written before this field existed. */
  providerUsd?: number;
  /** Local compute estimates only; absent on sessions written before this field existed. */
  localComputeUsd?: number;
  localActiveMs?: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Turns that contributed a known cost. */
  meteredTurns: number;
  /** Turns whose cost could not be resolved (no usage or no pricing). */
  unknownCostTurns: number;
  /** Stage-aware call count. Newer code uses this; meteredTurns remains for compatibility. */
  meteredEntries?: number;
  unknownCostEntries?: number;
  currency: string;
};

/**
 * Built-in approximate list prices (USD / 1M tokens) for the default panel and
 * common judges, from the pricing registry (spec/registry/pricing.json,
 * refreshed by scripts/generate-pricing.mjs). Used when the gateway is not
 * given explicit pricing. Resolved by exact id, then {@link PRICING_ALIASES};
 * unknown ids are flagged `unknownCost`. Thread real pricing through config to override.
 */
export const DEFAULT_MODEL_PRICING: Readonly<Record<string, ModelPricing>> =
  REGISTRY_MODEL_PRICING;

const DEFAULT_CURRENCY = "USD";
const loggedUnknownPricing = new Set<string>();

function logUnknownPricing(model: string): void {
  const key = model.toLowerCase();
  if (loggedUnknownPricing.has(key)) return;
  loggedUnknownPricing.add(key);
  process.stderr.write(`no price for ${model}; spend shown as unknown\n`);
}

function numberAt(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Parse a usage block in either OpenAI (`prompt_tokens`/`completion_tokens`/
 * `total_tokens`) or Anthropic (`input_tokens`/`output_tokens`) shape into a
 * uniform {@link TokenUsage}. Returns `undefined` when no token field is found.
 */
export function parseUsage(usage: unknown): TokenUsage | undefined {
  const record = asRecord(usage);
  if (record === undefined) return undefined;
  const prompt = numberAt(record, "prompt_tokens") ?? numberAt(record, "input_tokens");
  const completion = numberAt(record, "completion_tokens") ?? numberAt(record, "output_tokens");
  const total =
    numberAt(record, "total_tokens") ??
    (prompt !== undefined && completion !== undefined ? prompt + completion : undefined);
  if (prompt === undefined && completion === undefined && total === undefined) return undefined;
  return {
    ...(prompt !== undefined ? { promptTokens: prompt } : {}),
    ...(completion !== undefined ? { completionTokens: completion } : {}),
    ...(total !== undefined ? { totalTokens: total } : {})
  };
}

/** Extract the last `usage` block carried on an OpenAI-style SSE stream. */
export function parseUsageFromSse(text: string): TokenUsage | undefined {
  let usage: TokenUsage | undefined;
  for (const event of decodeBufferedSse(text)) {
    if (event.data.length === 0 || event.data === "[DONE]") continue;
    let json: { usage?: unknown };
    try {
      json = JSON.parse(event.data) as { usage?: unknown };
    } catch {
      // Best-effort post-hoc metering: skip a non-JSON payload rather than
      // failing the whole scan (unlike a live stream, this text is buffered).
      continue;
    }
    const parsed = parseUsage(json.usage);
    if (parsed !== undefined) usage = parsed;
  }
  return usage;
}

/**
 * Resolve pricing for a model: exact match, then alias table. `overrides` win over
 * the built-in table. Unknown ids return `undefined` (never prefix-matched).
 */
export function lookupPricing(
  model: string,
  overrides: Readonly<Record<string, ModelPricing>> = {}
): ModelPricing | undefined {
  const table = { ...DEFAULT_MODEL_PRICING, ...overrides };
  return lookupPricingIn(model, table, PRICING_ALIASES);
}

function resolveAlias(
  model: string,
  aliases: Readonly<Record<string, string>>
): string | undefined {
  const key = model.toLowerCase();
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (alias.toLowerCase() === key) return canonical;
  }
  return undefined;
}

function lookupPricingIn(
  model: string,
  table: Readonly<Record<string, ModelPricing>>,
  aliases: Readonly<Record<string, string>> = PRICING_ALIASES
): ModelPricing | undefined {
  const key = model.toLowerCase();
  for (const [candidate, pricing] of Object.entries(table)) {
    if (candidate.toLowerCase() === key) return pricing;
  }
  const canonical = resolveAlias(model, aliases);
  if (canonical !== undefined) {
    for (const [candidate, pricing] of Object.entries(table)) {
      if (candidate.toLowerCase() === canonical.toLowerCase()) return pricing;
    }
  }
  logUnknownPricing(model);
  return undefined;
}

function meterTurnWithPricing(
  model: string,
  usage: TokenUsage | undefined,
  pricing: ModelPricing | undefined
): TurnCost {
  const resolved = usage ?? {};
  const unknownUsage = usage === undefined;
  const estimate = unknownUsage ? undefined : estimateCost(resolved, pricing);
  const providerCostUsd = estimate?.costUsd;
  return {
    model,
    usage: resolved,
    ...(providerCostUsd !== undefined ? { costUsd: providerCostUsd, providerCostUsd } : {}),
    unknownUsage,
    unknownCost: providerCostUsd === undefined,
    ...(estimate?.partialUsage === true ? { partialUsage: true } : {}),
    currency: pricing?.currency ?? DEFAULT_CURRENCY
  };
}

/** Compute the USD cost of `usage` under `pricing`, or `undefined` if not derivable. */
export function estimateCost(
  usage: TokenUsage,
  pricing: ModelPricing | undefined
): { costUsd: number; partialUsage: boolean } | undefined {
  if (pricing === undefined) return undefined;
  const hasPrompt = usage.promptTokens !== undefined;
  const hasCompletion = usage.completionTokens !== undefined;
  if (!hasPrompt && !hasCompletion) return undefined;
  const promptTokens = usage.promptTokens ?? 0;
  const completionTokens = usage.completionTokens ?? 0;
  const input = (promptTokens * pricing.inputPer1mTokens) / 1_000_000;
  const output = (completionTokens * pricing.outputPer1mTokens) / 1_000_000;
  return {
    costUsd: input + output,
    partialUsage: !hasPrompt || !hasCompletion
  };
}

export function estimateLocalComputeCost(input: LocalComputeUsage | undefined): number | undefined {
  if (input?.activeInferenceMs === undefined || input.usdPerDeviceHour === undefined) return undefined;
  return (input.activeInferenceMs / 3_600_000) * input.usdPerDeviceHour;
}

export function localComputeFromLatency(input: {
  latencyMs?: number;
  modelRepo?: string;
  deviceKind?: string;
  pricing?: LocalComputePricing;
}): LocalComputeUsage | undefined {
  if (input.latencyMs === undefined && input.pricing?.usdPerDeviceHour === undefined) return undefined;
  const localCompute: LocalComputeUsage = {
    ...(input.latencyMs !== undefined ? { activeInferenceMs: input.latencyMs } : {}),
    ...(input.modelRepo !== undefined ? { modelRepo: input.modelRepo } : {}),
    ...(input.deviceKind !== undefined ? { deviceKind: input.deviceKind } : {}),
    ...(input.pricing?.usdPerDeviceHour !== undefined ? { usdPerDeviceHour: input.pricing.usdPerDeviceHour } : {})
  };
  const estimated = estimateLocalComputeCost(localCompute);
  return {
    ...localCompute,
    ...(estimated !== undefined ? { estimatedCostUsd: estimated } : {})
  };
}

/**
 * Meter one turn: resolve pricing and compute cost (clearly marking unknowns).
 * `usage` is the already-parsed {@link TokenUsage} (use {@link parseUsage} /
 * {@link parseUsageFromSse} on the response first), or `undefined` when the
 * response carried none.
 */
export function meterTurn(
  model: string,
  usage: TokenUsage | undefined,
  overrides: Readonly<Record<string, ModelPricing>> = {}
): TurnCost {
  const pricing = lookupPricing(model, overrides);
  return meterTurnWithPricing(model, usage, pricing);
}

export function meterCall(input: {
  model: string;
  usage: TokenUsage | undefined;
  stage: CostStage;
  pricing?: Readonly<Record<string, ModelPricing>>;
  turn?: number;
  provider?: string;
  endpointId?: string;
  latencyMs?: number;
  providerCost?: ProviderCostMetadata;
  localCompute?: LocalComputeUsage;
  recordedAt?: number;
}): CostLedgerEntry {
  const providerLookupFailed =
    input.providerCost?.source === "provider" &&
    input.providerCost.costUsd === undefined &&
    input.providerCost.lookupStatus !== undefined;
  const pricing = providerLookupFailed
    ? lookupPricingIn(input.model, input.pricing ?? {}, PRICING_ALIASES)
    : lookupPricing(input.model, input.pricing ?? {});
  const tokenCost = meterTurnWithPricing(input.model, input.usage, pricing);
  const exactProviderCostUsd =
    input.providerCost?.source === "provider" ? input.providerCost.costUsd : undefined;
  const providerCostUsd = exactProviderCostUsd ?? tokenCost.providerCostUsd;
  const localComputeCostUsd =
    input.localCompute?.estimatedCostUsd ?? estimateLocalComputeCost(input.localCompute);
  const costUsd = providerCostUsd;
  const providerCost =
    input.providerCost !== undefined
      ? providerLookupFailed && providerCostUsd !== undefined
        ? {
            ...input.providerCost,
            source: "estimate" as const,
            costUsd: providerCostUsd,
            lookupStatus: `fallback_${input.providerCost.lookupStatus}`
          }
        : input.providerCost
      : tokenCost.providerCostUsd !== undefined
        ? {
            source: "estimate" as const,
            costUsd: tokenCost.providerCostUsd,
            lookupStatus: "estimated_from_pricing"
          }
        : undefined;
  return {
    ...tokenCost,
    entryId: randomId(8, `${input.stage}_${input.turn ?? "na"}_`),
    stage: input.stage,
    recordedAt: input.recordedAt ?? Date.now(),
    ...(input.turn !== undefined ? { turn: input.turn } : {}),
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.endpointId !== undefined ? { endpointId: input.endpointId } : {}),
    ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
    ...(providerCost !== undefined ? { providerCost } : {}),
    ...(input.localCompute !== undefined ? { localCompute: input.localCompute } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(providerCostUsd !== undefined ? { providerCostUsd } : {}),
    ...(localComputeCostUsd !== undefined ? { localComputeCostUsd } : {}),
    unknownCost: providerCostUsd === undefined,
    currency: tokenCost.currency
  };
}

/** A fresh zeroed session-cost accumulator. */
export function emptySessionCost(currency = DEFAULT_CURRENCY): SessionCost {
  return {
    totalUsd: 0,
    providerUsd: 0,
    localComputeUsd: 0,
    localActiveMs: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    meteredTurns: 0,
    unknownCostTurns: 0,
    meteredEntries: 0,
    unknownCostEntries: 0,
    currency
  };
}

/** Fold a turn's cost into the running session accumulation (returns a new object). */
export function addTurnCost(total: SessionCost, turn: TurnCost): SessionCost {
  const totalTokens =
    turn.usage.totalTokens ??
    (turn.usage.promptTokens ?? 0) + (turn.usage.completionTokens ?? 0);
  const providerUsd = turn.providerCostUsd ?? turn.costUsd ?? 0;
  return {
    totalUsd: total.totalUsd + providerUsd,
    providerUsd: (total.providerUsd ?? 0) + providerUsd,
    localComputeUsd: total.localComputeUsd ?? 0,
    localActiveMs: total.localActiveMs ?? 0,
    promptTokens: total.promptTokens + (turn.usage.promptTokens ?? 0),
    completionTokens: total.completionTokens + (turn.usage.completionTokens ?? 0),
    totalTokens: total.totalTokens + totalTokens,
    meteredTurns: total.meteredTurns + (turn.unknownCost ? 0 : 1),
    unknownCostTurns: total.unknownCostTurns + (turn.unknownCost ? 1 : 0),
    meteredEntries: (total.meteredEntries ?? total.meteredTurns) + (turn.unknownCost ? 0 : 1),
    unknownCostEntries: (total.unknownCostEntries ?? total.unknownCostTurns) + (turn.unknownCost ? 1 : 0),
    currency: total.currency
  };
}

export function addLedgerEntry(total: SessionCost, entry: CostLedgerEntry): SessionCost {
  const totalTokens =
    entry.usage.totalTokens ??
    (entry.usage.promptTokens ?? 0) + (entry.usage.completionTokens ?? 0);
  const providerUsd = entry.providerCostUsd ?? 0;
  const localUsd = entry.localComputeCostUsd ?? 0;
  return {
    totalUsd: total.totalUsd + providerUsd,
    providerUsd: (total.providerUsd ?? 0) + providerUsd,
    localComputeUsd: (total.localComputeUsd ?? 0) + localUsd,
    localActiveMs:
      (total.localActiveMs ?? 0) + (entry.localCompute?.activeInferenceMs ?? 0),
    promptTokens: total.promptTokens + (entry.usage.promptTokens ?? 0),
    completionTokens: total.completionTokens + (entry.usage.completionTokens ?? 0),
    totalTokens: total.totalTokens + totalTokens,
    meteredTurns: total.meteredTurns + (entry.unknownCost ? 0 : 1),
    unknownCostTurns: total.unknownCostTurns + (entry.unknownCost ? 1 : 0),
    meteredEntries: (total.meteredEntries ?? total.meteredTurns) + (entry.unknownCost ? 0 : 1),
    unknownCostEntries: (total.unknownCostEntries ?? total.unknownCostTurns) + (entry.unknownCost ? 1 : 0),
    currency: total.currency
  };
}

/** Format USD (or other currency) compactly, e.g. `$0.0123` or `$1.20`. */
export function formatUsd(amount: number, currency = DEFAULT_CURRENCY): string {
  const digits = amount > 0 && amount < 0.01 ? 4 : amount < 1 ? 4 : 2;
  const sign = currency === DEFAULT_CURRENCY ? "$" : "";
  const suffix = currency === DEFAULT_CURRENCY ? "" : ` ${currency}`;
  return `${sign}${amount.toFixed(digits)}${suffix}`;
}

/** A concise one-line per-turn cost summary for traces / stderr. */
export function turnCostLine(turn: TurnCost, sessionTotalUsd: number): string {
  const tokens =
    `${turn.usage.promptTokens ?? "?"}+${turn.usage.completionTokens ?? "?"} tokens`;
  const turnCost = turn.unknownCost ? "cost unknown" : formatUsd(turn.costUsd ?? 0, turn.currency);
  const sessionCost = formatUsd(sessionTotalUsd, turn.currency);
  return `cost: ${turn.model} ${tokens}, this turn ${turnCost}; session total ${sessionCost}`;
}
