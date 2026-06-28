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
 * Scope. The Node gateway meters only the usage that flows through it. For a
 * fused turn that is the judge/synthesis call; the individual panel members run
 * inside the Python engine, which meters their own usage/cost
 * (`fusionkit_core.providers.estimate_cost`). The gateway total is therefore the
 * gateway-observed cost, not a whole-pipeline bill — surfaced as such.
 */

/** USD price for a model, per 1,000,000 tokens. */
export type ModelPricing = {
  inputPer1mTokens: number;
  outputPer1mTokens: number;
  /** ISO 4217 currency; defaults to USD. */
  currency?: string;
};

/** Prompt / completion / total token counts parsed from a `usage` block. */
export type TokenUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

/** The cost of a single metered turn. */
export type TurnCost = {
  model: string;
  usage: TokenUsage;
  /** Resolved USD cost, or `undefined` when usage or pricing is unknown. */
  costUsd?: number;
  unknownUsage: boolean;
  unknownCost: boolean;
  currency: string;
};

/** The running per-session accumulation persisted with the session header. */
export type SessionCost = {
  totalUsd: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Turns that contributed a known cost. */
  meteredTurns: number;
  /** Turns whose cost could not be resolved (no usage or no pricing). */
  unknownCostTurns: number;
  currency: string;
};

/**
 * Built-in approximate list prices (USD / 1M tokens) for the default panel and
 * common judges. Used when the gateway is not given explicit pricing. Matched
 * by longest-prefix so a dated model id (`gpt-5.5-2026-01`) still resolves.
 * These are coarse defaults; thread real pricing through the config to override.
 */
export const DEFAULT_MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  "gpt-5.5": { inputPer1mTokens: 1.25, outputPer1mTokens: 10 },
  "gpt-5": { inputPer1mTokens: 1.25, outputPer1mTokens: 10 },
  "gpt-4.1": { inputPer1mTokens: 2, outputPer1mTokens: 8 },
  "gpt-4o": { inputPer1mTokens: 2.5, outputPer1mTokens: 10 },
  "o3": { inputPer1mTokens: 2, outputPer1mTokens: 8 },
  "claude-sonnet-4-6": { inputPer1mTokens: 3, outputPer1mTokens: 15 },
  "claude-sonnet": { inputPer1mTokens: 3, outputPer1mTokens: 15 },
  "claude-opus": { inputPer1mTokens: 15, outputPer1mTokens: 75 },
  "claude-haiku": { inputPer1mTokens: 1, outputPer1mTokens: 5 },
  "gemini-2.5-pro": { inputPer1mTokens: 1.25, outputPer1mTokens: 10 },
  "gemini-2.5-flash": { inputPer1mTokens: 0.3, outputPer1mTokens: 2.5 }
};

const DEFAULT_CURRENCY = "USD";

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
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload.length === 0 || payload === "[DONE]") continue;
    try {
      const json = JSON.parse(payload) as { usage?: unknown };
      const parsed = parseUsage(json.usage);
      if (parsed !== undefined) usage = parsed;
    } catch {
      // partial / non-JSON line
    }
  }
  return usage;
}

/**
 * Resolve pricing for a model: exact match first, then the longest matching
 * prefix key (so `gpt-5.5-2026-01` resolves via `gpt-5.5`). `overrides` win over
 * the built-in table.
 */
export function lookupPricing(
  model: string,
  overrides: Readonly<Record<string, ModelPricing>> = {}
): ModelPricing | undefined {
  const table = { ...DEFAULT_MODEL_PRICING, ...overrides };
  const key = model.toLowerCase();
  if (table[key] !== undefined) return table[key];
  let best: { length: number; pricing: ModelPricing } | undefined;
  for (const [candidate, pricing] of Object.entries(table)) {
    if (key.startsWith(candidate) && (best === undefined || candidate.length > best.length)) {
      best = { length: candidate.length, pricing };
    }
  }
  return best?.pricing;
}

/** Compute the USD cost of `usage` under `pricing`, or `undefined` if not derivable. */
export function estimateCost(usage: TokenUsage, pricing: ModelPricing | undefined): number | undefined {
  if (pricing === undefined) return undefined;
  if (usage.promptTokens === undefined || usage.completionTokens === undefined) return undefined;
  const input = (usage.promptTokens * pricing.inputPer1mTokens) / 1_000_000;
  const output = (usage.completionTokens * pricing.outputPer1mTokens) / 1_000_000;
  return input + output;
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
  const resolved = usage ?? {};
  const unknownUsage = usage === undefined;
  const pricing = lookupPricing(model, overrides);
  const costUsd = unknownUsage ? undefined : estimateCost(resolved, pricing);
  return {
    model,
    usage: resolved,
    ...(costUsd !== undefined ? { costUsd } : {}),
    unknownUsage,
    unknownCost: costUsd === undefined,
    currency: pricing?.currency ?? DEFAULT_CURRENCY
  };
}

/** A fresh zeroed session-cost accumulator. */
export function emptySessionCost(currency = DEFAULT_CURRENCY): SessionCost {
  return {
    totalUsd: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    meteredTurns: 0,
    unknownCostTurns: 0,
    currency
  };
}

/** Fold a turn's cost into the running session accumulation (returns a new object). */
export function addTurnCost(total: SessionCost, turn: TurnCost): SessionCost {
  const totalTokens =
    turn.usage.totalTokens ??
    (turn.usage.promptTokens ?? 0) + (turn.usage.completionTokens ?? 0);
  return {
    totalUsd: total.totalUsd + (turn.costUsd ?? 0),
    promptTokens: total.promptTokens + (turn.usage.promptTokens ?? 0),
    completionTokens: total.completionTokens + (turn.usage.completionTokens ?? 0),
    totalTokens: total.totalTokens + totalTokens,
    meteredTurns: total.meteredTurns + (turn.unknownCost ? 0 : 1),
    unknownCostTurns: total.unknownCostTurns + (turn.unknownCost ? 1 : 0),
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
