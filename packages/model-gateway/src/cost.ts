import {
  DEFAULT_MODEL_PRICING as REGISTRY_MODEL_PRICING,
  PRICING_ALIASES
} from "@velum-labs/routekit-registry";

import { decodeBufferedSse } from "./sse/parse.js";

export type ModelPricing = {
  inputPer1mTokens: number;
  outputPer1mTokens: number;
  currency?: string;
};

export type TokenUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
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

export type CallCostRecord = {
  model: string;
  usage: TokenUsage;
  costUsd?: number;
  providerCostUsd?: number;
  unknownUsage: boolean;
  unknownCost: boolean;
  partialUsage?: boolean;
  currency: string;
  providerCost?: ProviderCostMetadata;
};

const DEFAULT_CURRENCY = "USD";
export const DEFAULT_MODEL_PRICING: Readonly<Record<string, ModelPricing>> =
  REGISTRY_MODEL_PRICING;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function parseUsage(value: unknown): TokenUsage | undefined {
  const usage = asRecord(value);
  if (usage === undefined) return undefined;
  const prompt = nonnegativeNumber(usage.prompt_tokens) ?? nonnegativeNumber(usage.input_tokens);
  const completion =
    nonnegativeNumber(usage.completion_tokens) ?? nonnegativeNumber(usage.output_tokens);
  const total =
    nonnegativeNumber(usage.total_tokens) ??
    (prompt !== undefined && completion !== undefined ? prompt + completion : undefined);
  if (prompt === undefined && completion === undefined && total === undefined) return undefined;
  return {
    ...(prompt !== undefined ? { promptTokens: prompt } : {}),
    ...(completion !== undefined ? { completionTokens: completion } : {}),
    ...(total !== undefined ? { totalTokens: total } : {})
  };
}

export function parseUsageFromSse(text: string): TokenUsage | undefined {
  let usage: TokenUsage | undefined;
  for (const event of decodeBufferedSse(text)) {
    const data = event.data.trim();
    if (data.length === 0 || data === "[DONE]") continue;
    try {
      const parsed = asRecord(JSON.parse(data));
      const candidate =
        parseUsage(parsed?.usage) ??
        parseUsage(asRecord(parsed?.response)?.usage);
      if (candidate !== undefined) usage = candidate;
    } catch {
      // Usage extraction is observational and ignores malformed events.
    }
  }
  return usage;
}

function canonicalPricingKey(model: string): string {
  const direct = Object.keys(DEFAULT_MODEL_PRICING).find(
    (candidate) => candidate.toLowerCase() === model.toLowerCase()
  );
  if (direct !== undefined) return direct;
  const alias = Object.entries(PRICING_ALIASES).find(
    ([candidate]) => candidate.toLowerCase() === model.toLowerCase()
  );
  return alias?.[1] ?? model;
}

export function lookupPricing(
  model: string,
  overrides: Readonly<Record<string, ModelPricing>> = {}
): ModelPricing | undefined {
  const combined: Readonly<Record<string, ModelPricing>> = {
    ...DEFAULT_MODEL_PRICING,
    ...overrides
  };
  const key = canonicalPricingKey(model);
  const entry = Object.entries(combined).find(
    ([candidate]) => candidate.toLowerCase() === key.toLowerCase()
  );
  return entry?.[1];
}

export function estimateCost(
  usage: TokenUsage,
  pricing: ModelPricing | undefined
): { costUsd: number; partialUsage: boolean } | undefined {
  if (pricing === undefined) return undefined;
  const hasPrompt = usage.promptTokens !== undefined;
  const hasCompletion = usage.completionTokens !== undefined;
  if (!hasPrompt && !hasCompletion) return undefined;
  return {
    costUsd:
      ((usage.promptTokens ?? 0) * pricing.inputPer1mTokens +
        (usage.completionTokens ?? 0) * pricing.outputPer1mTokens) /
      1_000_000,
    partialUsage: !hasPrompt || !hasCompletion
  };
}

export function meterCall(input: {
  model: string;
  usage?: TokenUsage;
  pricing?: Readonly<Record<string, ModelPricing>>;
  providerCost?: ProviderCostMetadata;
}): CallCostRecord {
  const usage = input.usage ?? {};
  const providerLookupFailed =
    input.providerCost?.source === "provider" &&
    input.providerCost.costUsd === undefined &&
    input.providerCost.lookupStatus !== undefined;
  const configuredPricing = input.pricing ?? {};
  const pricing = providerLookupFailed
    ? Object.entries(configuredPricing).find(
        ([candidate]) => candidate.toLowerCase() === input.model.toLowerCase()
      )?.[1]
    : lookupPricing(input.model, configuredPricing);
  const estimate = estimateCost(usage, pricing);
  const exact =
    input.providerCost?.source === "provider" ? input.providerCost.costUsd : undefined;
  const providerCostUsd = exact ?? estimate?.costUsd;
  const providerCost =
    providerLookupFailed && providerCostUsd !== undefined
      ? {
          ...input.providerCost,
          source: "estimate" as const,
          costUsd: providerCostUsd,
          lookupStatus: `fallback_${input.providerCost?.lookupStatus}`
        }
      : input.providerCost;
  return {
    model: input.model,
    usage,
    ...(providerCostUsd !== undefined ? { costUsd: providerCostUsd, providerCostUsd } : {}),
    unknownUsage: input.usage === undefined,
    unknownCost: providerCostUsd === undefined,
    ...(estimate?.partialUsage === true ? { partialUsage: true } : {}),
    currency: pricing?.currency ?? DEFAULT_CURRENCY,
    ...(providerCost !== undefined ? { providerCost } : {})
  };
}

export function formatUsd(amount: number, currency = DEFAULT_CURRENCY): string {
  const digits = amount >= 1 ? 2 : 4;
  return `${currency === "USD" ? "$" : ""}${amount.toFixed(digits)}${
    currency === "USD" ? "" : ` ${currency}`
  }`;
}
