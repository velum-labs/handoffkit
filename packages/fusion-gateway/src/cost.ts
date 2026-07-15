import { randomId } from "@routekit/runtime";
import {
  estimateCost,
  formatUsd,
  lookupPricing,
  meterCall as meterProviderCall,
  parseUsage,
  parseUsageFromSse
} from "@routekit/gateway";
import type {
  CallCostRecord,
  ModelPricing,
  ProviderCostMetadata,
  TokenUsage
} from "@routekit/gateway";

export {
  estimateCost,
  formatUsd,
  lookupPricing,
  parseUsage,
  parseUsageFromSse
};
export type {
  CallCostRecord,
  ModelPricing,
  ProviderCostMetadata,
  TokenUsage
};

export type LocalComputeUsage = {
  activeInferenceMs?: number;
  loadMs?: number;
  serverUptimeMs?: number;
  tokensPerSecond?: number;
  modelRepo?: string;
  deviceKind?: string;
  usdPerDeviceHour?: number;
  estimatedCostUsd?: number;
};

export type LocalComputePricing = {
  usdPerDeviceHour?: number;
};

export type CostStage = "panel" | "judge_synth" | "passthrough" | "narrator" | "local";

export type TurnCost = CallCostRecord & {
  localComputeCostUsd?: number;
};

export type CostLedgerEntry = TurnCost & {
  entryId: string;
  stage: CostStage;
  recordedAt: number;
  turn?: number;
  provider?: string;
  endpointId?: string;
  latencyMs?: number;
  localCompute?: LocalComputeUsage;
};

export type SessionCost = {
  totalUsd: number;
  providerUsd?: number;
  localComputeUsd?: number;
  localActiveMs?: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  meteredTurns: number;
  unknownCostTurns: number;
  meteredEntries?: number;
  unknownCostEntries?: number;
  currency: string;
};

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
  const usage: LocalComputeUsage = {
    ...(input.latencyMs !== undefined ? { activeInferenceMs: input.latencyMs } : {}),
    ...(input.modelRepo !== undefined ? { modelRepo: input.modelRepo } : {}),
    ...(input.deviceKind !== undefined ? { deviceKind: input.deviceKind } : {}),
    ...(input.pricing?.usdPerDeviceHour !== undefined
      ? { usdPerDeviceHour: input.pricing.usdPerDeviceHour }
      : {})
  };
  const estimatedCostUsd = estimateLocalComputeCost(usage);
  return {
    ...usage,
    ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {})
  };
}

export function meterTurn(
  model: string,
  usage: TokenUsage | undefined,
  pricing: Readonly<Record<string, ModelPricing>> = {}
): TurnCost {
  return meterProviderCall({ model, usage, pricing });
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
  const call = meterProviderCall({
    model: input.model,
    usage: input.usage,
    pricing: input.pricing,
    providerCost: input.providerCost
  });
  const localComputeCostUsd =
    input.localCompute?.estimatedCostUsd ?? estimateLocalComputeCost(input.localCompute);
  return {
    ...call,
    entryId: randomId(8, `${input.stage}_${input.turn ?? "na"}_`),
    stage: input.stage,
    recordedAt: input.recordedAt ?? Date.now(),
    ...(input.turn !== undefined ? { turn: input.turn } : {}),
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.endpointId !== undefined ? { endpointId: input.endpointId } : {}),
    ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
    ...(input.localCompute !== undefined ? { localCompute: input.localCompute } : {}),
    ...(localComputeCostUsd !== undefined ? { localComputeCostUsd } : {})
  };
}

export function emptySessionCost(currency = "USD"): SessionCost {
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

export function addTurnCost(total: SessionCost, turn: TurnCost): SessionCost {
  const totalTokens =
    turn.usage.totalTokens ??
    (turn.usage.promptTokens ?? 0) + (turn.usage.completionTokens ?? 0);
  const providerUsd = turn.providerCostUsd ?? turn.costUsd ?? 0;
  return {
    ...total,
    totalUsd: total.totalUsd + providerUsd,
    providerUsd: (total.providerUsd ?? 0) + providerUsd,
    promptTokens: total.promptTokens + (turn.usage.promptTokens ?? 0),
    completionTokens: total.completionTokens + (turn.usage.completionTokens ?? 0),
    totalTokens: total.totalTokens + totalTokens,
    meteredTurns: total.meteredTurns + (turn.unknownCost ? 0 : 1),
    unknownCostTurns: total.unknownCostTurns + (turn.unknownCost ? 1 : 0),
    meteredEntries: (total.meteredEntries ?? total.meteredTurns) + (turn.unknownCost ? 0 : 1),
    unknownCostEntries:
      (total.unknownCostEntries ?? total.unknownCostTurns) + (turn.unknownCost ? 1 : 0)
  };
}

export function addLedgerEntry(total: SessionCost, entry: CostLedgerEntry): SessionCost {
  const next = addTurnCost(total, entry);
  const localUsd = entry.localComputeCostUsd ?? 0;
  return {
    ...next,
    localComputeUsd: (total.localComputeUsd ?? 0) + localUsd,
    localActiveMs: (total.localActiveMs ?? 0) + (entry.localCompute?.activeInferenceMs ?? 0)
  };
}

export function turnCostLine(turn: TurnCost, sessionTotalUsd: number): string {
  const tokens = `${turn.usage.promptTokens ?? "?"}+${turn.usage.completionTokens ?? "?"} tokens`;
  const cost = turn.unknownCost ? "cost unknown" : formatUsd(turn.costUsd ?? 0, turn.currency);
  return `cost: ${turn.model} ${tokens}, this turn ${cost}; session total ${formatUsd(
    sessionTotalUsd,
    turn.currency
  )}`;
}
