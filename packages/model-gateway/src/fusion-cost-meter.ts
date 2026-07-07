import { ATTR } from "@fusionkit/protocol";
import type { WireTrajectory } from "@fusionkit/protocol";
import { emitFusionMarker, jsonAttr } from "@fusionkit/tracing";
import type { FusionTraceCarrier } from "@fusionkit/tracing";

import { decodeBufferedSse } from "./sse/parse.js";

import {
  addLedgerEntry,
  emptySessionCost,
  formatUsd,
  localComputeFromLatency,
  meterCall,
  parseUsage,
  parseUsageFromSse,
  turnCostLine
} from "./cost.js";
import type {
  CostLedgerEntry,
  CostStage,
  LocalComputePricing,
  ModelPricing,
  ProviderCostMetadata,
  SessionCost,
  TokenUsage,
  TurnCost
} from "./cost.js";
import { errorEvent, sseResponse } from "./sse-wire.js";
import type { FusionGatewayLogger } from "./logger.js";
import type { SessionStore } from "./session-store.js";
import type { FusionBackendKernelStateStore } from "./fusion-types.js";
import { errorText, PendingSessionWrites } from "./fusion-session.js";

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function trajectoryMetadata(trajectory: WireTrajectory): Record<string, unknown> {
  return recordOf(trajectory.metadata) ?? {};
}

export function trajectoryUsage(trajectory: WireTrajectory): TokenUsage | undefined {
  const direct = parseUsage((trajectory as { usage?: unknown }).usage);
  if (direct !== undefined) return direct;
  return parseUsage(trajectoryMetadata(trajectory).usage);
}

export function providerCostMetadata(value: unknown): ProviderCostMetadata | undefined {
  const record = recordOf(value);
  if (record === undefined) return undefined;
  const rawSource = optionalString(record.source);
  const source = rawSource === "provider" || rawSource === "estimate" ? rawSource : "provider";
  const costUsd =
    optionalFiniteNumber(record.cost_usd) ??
    optionalFiniteNumber(record.costUsd) ??
    optionalFiniteNumber(record.total_cost);
  const generationId = optionalString(record.generation_id) ?? optionalString(record.generationId);
  const providerName = optionalString(record.provider_name) ?? optionalString(record.providerName);
  const upstreamInferenceCost =
    optionalFiniteNumber(record.upstream_inference_cost) ??
    optionalFiniteNumber(record.upstreamInferenceCost);
  const cacheDiscount =
    optionalFiniteNumber(record.cache_discount) ?? optionalFiniteNumber(record.cacheDiscount);
  const lookupStatus = optionalString(record.lookup_status) ?? optionalString(record.lookupStatus);
  const tokensPrompt = optionalNumber(record.tokens_prompt) ?? optionalNumber(record.tokensPrompt);
  const tokensCompletion =
    optionalNumber(record.tokens_completion) ?? optionalNumber(record.tokensCompletion);
  const nativeTokensPrompt =
    optionalNumber(record.native_tokens_prompt) ?? optionalNumber(record.nativeTokensPrompt);
  const nativeTokensCompletion =
    optionalNumber(record.native_tokens_completion) ?? optionalNumber(record.nativeTokensCompletion);
  return {
    source,
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(generationId !== undefined ? { generationId } : {}),
    ...(providerName !== undefined ? { providerName } : {}),
    ...(upstreamInferenceCost !== undefined ? { upstreamInferenceCost } : {}),
    ...(cacheDiscount !== undefined ? { cacheDiscount } : {}),
    ...(lookupStatus !== undefined ? { lookupStatus } : {}),
    ...(tokensPrompt !== undefined ? { tokensPrompt } : {}),
    ...(tokensCompletion !== undefined ? { tokensCompletion } : {}),
    ...(nativeTokensPrompt !== undefined ? { nativeTokensPrompt } : {}),
    ...(nativeTokensCompletion !== undefined ? { nativeTokensCompletion } : {})
  };
}

export function usageWithProviderCost(
  usage: TokenUsage | undefined,
  providerCost: ProviderCostMetadata | undefined
): TokenUsage | undefined {
  if (providerCost === undefined) return usage;
  const promptTokens = providerCost.tokensPrompt ?? usage?.promptTokens;
  const completionTokens = providerCost.tokensCompletion ?? usage?.completionTokens;
  const totalTokens =
    promptTokens !== undefined && completionTokens !== undefined
      ? promptTokens + completionTokens
      : usage?.totalTokens;
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) return usage;
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {})
  };
}

export function providerCostFromPayload(payload: unknown): ProviderCostMetadata | undefined {
  const record = recordOf(payload);
  if (record === undefined) return undefined;
  return providerCostMetadata(record.provider_cost ?? record.providerCost);
}

export function providerCostFromSse(text: string): ProviderCostMetadata | undefined {
  let providerCost: ProviderCostMetadata | undefined;
  for (const event of decodeBufferedSse(text)) {
    if (event.data.length === 0 || event.data === "[DONE]") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data) as unknown;
    } catch {
      // Best-effort post-hoc metering: skip a non-JSON payload in a buffered scan.
      continue;
    }
    const candidate = providerCostFromPayload(parsed);
    if (candidate !== undefined) providerCost = candidate;
  }
  return providerCost;
}

export function trajectoryLatencyMs(trajectory: WireTrajectory): number | undefined {
  const metadata = trajectoryMetadata(trajectory);
  const latencyMs = optionalNumber(metadata.latency_ms);
  if (latencyMs !== undefined) return latencyMs;
  const latencyS = optionalNumber(metadata.latency_s);
  return latencyS !== undefined ? latencyS * 1000 : undefined;
}

export type FusionCostMeterOptions = {
  budgetUsd?: number;
  pricing: Readonly<Record<string, ModelPricing>>;
  localCompute: Readonly<Record<string, LocalComputePricing>>;
  localModels: ReadonlySet<string>;
  kernelStateStore: FusionBackendKernelStateStore;
  store?: SessionStore;
  logger: FusionGatewayLogger;
  /** Shared in-flight write tracker (one per gateway; awaited on shutdown). */
  pendingWrites?: PendingSessionWrites;
};

export class FusionCostMeter {
  readonly #budgetUsd: number | undefined;
  readonly #pricing: Readonly<Record<string, ModelPricing>>;
  readonly #localCompute: Readonly<Record<string, LocalComputePricing>>;
  readonly #localModels: ReadonlySet<string>;
  readonly #kernelStateStore: FusionBackendKernelStateStore;
  readonly #store: SessionStore | undefined;
  readonly #logger: FusionGatewayLogger;
  readonly #pendingWrites: PendingSessionWrites;

  constructor(options: FusionCostMeterOptions) {
    this.#budgetUsd = options.budgetUsd;
    this.#pricing = options.pricing;
    this.#localCompute = options.localCompute;
    this.#localModels = options.localModels;
    this.#kernelStateStore = options.kernelStateStore;
    this.#store = options.store;
    this.#logger = options.logger;
    this.#pendingWrites = options.pendingWrites ?? new PendingSessionWrites();
  }

  get budgetUsd(): number | undefined {
    return this.#budgetUsd;
  }

  costFor(sessionId: string): SessionCost {
    const cached = this.#kernelStateStore.getCost(sessionId);
    if (cached !== undefined) return cached;
    const stored = this.#store?.load(sessionId)?.meta.cost;
    const seeded = stored ?? emptySessionCost();
    this.#kernelStateStore.setCost(sessionId, seeded);
    return seeded;
  }

  budgetStop(streaming: boolean, sessionId: string): Response {
    const total = this.costFor(sessionId);
    const message =
      `budget cap reached: this session has spent ${formatUsd(total.totalUsd, total.currency)} ` +
      `of the ${formatUsd(this.#budgetUsd ?? 0, total.currency)} --budget. ` +
      `Raise or remove --budget to continue.`;
    this.#logger.error(`fusion: ${message}`);
    if (streaming) return sseResponse(errorEvent(`fusion error: ${message}`));
    return new Response(JSON.stringify({ error: { message, type: "fusion_error" } }), {
      status: 402,
      headers: { "content-type": "application/json" }
    });
  }

  meterPanelCandidates(input: {
    sessionId: string;
    turn: number;
    trace: FusionTraceCarrier;
    meteredPanelTurns: Set<number>;
    candidates: readonly WireTrajectory[];
  }): void {
    if (input.meteredPanelTurns.has(input.turn)) return;
    input.meteredPanelTurns.add(input.turn);
    for (const candidate of input.candidates) {
      const metadata = trajectoryMetadata(candidate);
      const model = optionalString(candidate.model) ?? candidate.model_id;
      const endpointId = candidate.model_id;
      const provider = optionalString(metadata.provider);
      const latencyMs = trajectoryLatencyMs(candidate);
      const providerCost = providerCostMetadata(metadata.provider_cost ?? metadata.providerCost);
      const usage = usageWithProviderCost(trajectoryUsage(candidate), providerCost);
      const localCompute = this.#localComputeFor({
        model,
        endpointId,
        ...(provider !== undefined ? { provider } : {}),
        ...(latencyMs !== undefined ? { latencyMs } : {})
      });
      this.meterEntry(
        input.sessionId,
        {
          model,
          usage,
          stage: "panel",
          turn: input.turn,
          ...(provider !== undefined ? { provider } : {}),
          endpointId,
          ...(latencyMs !== undefined ? { latencyMs } : {}),
          ...(providerCost !== undefined ? { providerCost } : {}),
          ...(localCompute !== undefined ? { localCompute } : {})
        },
        input.trace
      );
    }
  }

  meterEntry(
    sessionId: string,
    input: {
      model: string;
      usage: TokenUsage | undefined;
      stage: CostStage;
      turn?: number;
      provider?: string;
      endpointId?: string;
      latencyMs?: number;
      providerCost?: ProviderCostMetadata;
      localCompute?: ReturnType<typeof localComputeFromLatency>;
    },
    trace?: FusionTraceCarrier
  ): CostLedgerEntry {
    const entry = meterCall({
      model: input.model,
      usage: input.usage,
      stage: input.stage,
      pricing: this.#pricing,
      ...(input.turn !== undefined ? { turn: input.turn } : {}),
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.endpointId !== undefined ? { endpointId: input.endpointId } : {}),
      ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
      ...(input.providerCost !== undefined ? { providerCost: input.providerCost } : {}),
      ...(input.localCompute !== undefined ? { localCompute: input.localCompute } : {})
    });
    const total = addLedgerEntry(this.costFor(sessionId), entry);
    this.#kernelStateStore.setCost(sessionId, total);
    if (this.#store !== undefined) {
      this.#pendingWrites.track(
        this.#store.recordCostEntry(sessionId, entry, total).catch((error: unknown) => {
          this.#logger.error(`fusion: could not persist cost for session ${sessionId}: ${errorText(error)}`);
        })
      );
    }
    const line = turnCostLine(entry, total.totalUsd);
    this.#logger.error(`fusion: ${input.stage} ${line}`);
    emitFusionMarker("gateway", "fusion.cost", trace, {
      [ATTR.FUSION_SESSION_ID]: sessionId,
      [ATTR.FUSION_TURN]: input.turn,
      [ATTR.FUSION_COST_STAGE]: input.stage,
      [ATTR.FUSION_COST_MODEL]: entry.model,
      [ATTR.FUSION_USAGE]: jsonAttr(entry.usage),
      [ATTR.GEN_AI_USAGE_INPUT_TOKENS]: entry.usage?.promptTokens,
      [ATTR.GEN_AI_USAGE_OUTPUT_TOKENS]: entry.usage?.completionTokens,
      [ATTR.FUSION_COST_TURN_USD]: entry.costUsd,
      [ATTR.FUSION_COST_PROVIDER_USD]: entry.providerCostUsd,
      [ATTR.FUSION_COST_LOCAL_COMPUTE_USD]: entry.localComputeCostUsd,
      [ATTR.FUSION_COST_SESSION_TOTAL_USD]: total.totalUsd,
      [ATTR.FUSION_COST_UNKNOWN]: entry.unknownCost,
      [ATTR.FUSION_COST_UNKNOWN_USAGE]: entry.unknownUsage
    });
    return entry;
  }

  meter(
    sessionId: string,
    model: string,
    usage: TokenUsage | undefined,
    trace?: FusionTraceCarrier,
    stage: CostStage = "passthrough",
    turn?: number
  ): TurnCost {
    return this.meterEntry(sessionId, { model, usage, stage, ...(turn !== undefined ? { turn } : {}) }, trace);
  }

  async meterResponseClone(
    response: Response,
    sessionId: string,
    model: string,
    trace?: FusionTraceCarrier,
    stage: CostStage = "passthrough",
    turn?: number
  ): Promise<void> {
    if (!response.ok) return;
    const clone = response.clone();
    try {
      const json = (await clone.json()) as { usage?: unknown };
      const providerCost = providerCostFromPayload(json);
      this.meterEntry(
        sessionId,
        {
          model,
          usage: usageWithProviderCost(parseUsage(json.usage), providerCost),
          stage,
          ...(turn !== undefined ? { turn } : {}),
          ...(providerCost !== undefined ? { providerCost } : {})
        },
        trace
      );
    } catch {
      // best-effort: an unreadable body means the turn is left unmetered.
    }
  }

  #localComputeFor(input: {
    model: string;
    endpointId: string;
    provider?: string;
    latencyMs?: number;
  }): ReturnType<typeof localComputeFromLatency> {
    const pricing = this.#localCompute[input.model] ?? this.#localCompute[input.endpointId];
    const looksLocal =
      this.#localModels.has(input.model) ||
      this.#localModels.has(input.endpointId) ||
      input.provider === "mlx-lm";
    if (pricing === undefined && !looksLocal) return undefined;
    return localComputeFromLatency({
      latencyMs: input.latencyMs,
      modelRepo: input.model,
      deviceKind: looksLocal ? "local" : undefined,
      ...(pricing !== undefined ? { pricing } : {})
    });
  }
}
