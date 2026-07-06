import type { RawEnvironment, StoredEvent } from "./types";

/**
 * Pure cross-session aggregations for the Models and Environments pages. Kept
 * dependency-free so they can be unit tested directly off a flat event list.
 */

export type ModelRollup = {
  modelId: string;
  provider?: string;
  calls: number;
  succeeded: number;
  failed: number;
  running: number;
  avgLatencyS?: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  lastTs: number;
};

function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Total tokens carried by a usage payload (total, or prompt + completion). */
export function tokensOf(usage: Record<string, unknown>): number {
  if (typeof usage.total_tokens === "number") return usage.total_tokens;
  const prompt = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const completion = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
  return prompt + completion;
}

/**
 * tokensOf for the gateway cost meter, whose usage payloads are camelCase
 * (internal TokenUsage) rather than the wire snake_case.
 */
function tokensOfAnyCase(usage: Record<string, unknown>): number {
  const snake = tokensOf(usage);
  if (snake > 0) return snake;
  if (typeof usage.totalTokens === "number") return usage.totalTokens;
  const prompt = typeof usage.promptTokens === "number" ? usage.promptTokens : 0;
  const completion = typeof usage.completionTokens === "number" ? usage.completionTokens : 0;
  return prompt + completion;
}

type ModelAcc = {
  modelId: string;
  provider?: string;
  calls: number;
  succeeded: number;
  failed: number;
  running: number;
  latencies: number[];
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  lastTs: number;
};

export function rollupModels(events: StoredEvent[]): ModelRollup[] {
  const byModel = new Map<string, ModelAcc>();
  const ensure = (modelId: string): ModelAcc => {
    let acc = byModel.get(modelId);
    if (acc === undefined) {
      acc = {
        modelId,
        calls: 0,
        succeeded: 0,
        failed: 0,
        running: 0,
        latencies: [],
        totalTokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        lastTs: 0
      };
      byModel.set(modelId, acc);
    }
    return acc;
  };

  for (const event of events) {
    const payload = obj(event.payload);
    const modelId = event.model_id ?? (typeof payload.model === "string" ? payload.model : undefined);
    if (modelId === undefined) continue;
    const acc = ensure(modelId);
    acc.lastTs = Math.max(acc.lastTs, event.ts);
    if (typeof payload.provider === "string") acc.provider = payload.provider;

    if (event.event_type === "model.call.started") {
      acc.calls += 1;
      acc.running += 1;
    } else if (event.event_type === "model.call.finished") {
      if (acc.running > 0) acc.running -= 1;
      if (payload.error !== undefined) acc.failed += 1;
      else acc.succeeded += 1;
      if (typeof payload.latency_s === "number") acc.latencies.push(payload.latency_s);
      const usage = obj(payload.usage);
      acc.totalTokens += tokensOf(usage);
      if (typeof usage.prompt_tokens === "number") acc.promptTokens += usage.prompt_tokens;
      if (typeof usage.completion_tokens === "number") acc.completionTokens += usage.completion_tokens;
    }
  }

  return [...byModel.values()]
    .map((acc): ModelRollup => ({
      modelId: acc.modelId,
      ...(acc.provider !== undefined ? { provider: acc.provider } : {}),
      calls: acc.calls,
      succeeded: acc.succeeded,
      failed: acc.failed,
      running: acc.running,
      ...(acc.latencies.length > 0
        ? { avgLatencyS: acc.latencies.reduce((sum, value) => sum + value, 0) / acc.latencies.length }
        : {}),
      totalTokens: acc.totalTokens,
      promptTokens: acc.promptTokens,
      completionTokens: acc.completionTokens,
      lastTs: acc.lastTs
    }))
    .sort((a, b) => b.calls - a.calls || b.lastTs - a.lastTs);
}

// ---- cost ----

export type CostModelRow = {
  model: string;
  stage?: string;
  entries: number;
  usd: number;
  tokens: number;
  lastTs: number;
};

export type CostRollup = {
  /** Sum of every resolved cost entry, in USD. */
  totalUsd: number;
  entries: number;
  /** Entries whose cost could not be resolved (unknown pricing/usage). */
  unknownEntries: number;
  sessionsWithCost: number;
  perModel: CostModelRow[];
  perStage: Array<{ stage: string; entries: number; usd: number }>;
};

/**
 * Fold the gateway cost meter's `log`/`cost.metered` events into spend
 * rollups. Costs are attributed to the priced model name and the metering
 * stage (panel, judge_synth, passthrough, local).
 */
export function rollupCost(events: StoredEvent[]): CostRollup {
  const perModel = new Map<string, CostModelRow>();
  const perStage = new Map<string, { stage: string; entries: number; usd: number }>();
  const sessions = new Set<string>();
  let totalUsd = 0;
  let entries = 0;
  let unknownEntries = 0;

  for (const event of events) {
    const payload = obj(event.payload);
    if (event.event_type !== "log" || payload.kind !== "cost.metered") continue;
    entries += 1;
    const stage = typeof payload.stage === "string" ? payload.stage : "unknown";
    const model = typeof payload.model === "string" ? payload.model : "unknown";
    const usd = typeof payload.turn_cost_usd === "number" ? payload.turn_cost_usd : 0;
    if (payload.unknown_cost === true) unknownEntries += 1;
    totalUsd += usd;
    if (usd > 0) sessions.add(event.trace_id);

    const key = `${model}\u0000${stage}`;
    const row = perModel.get(key) ?? { model, stage, entries: 0, usd: 0, tokens: 0, lastTs: 0 };
    row.entries += 1;
    row.usd += usd;
    row.tokens += tokensOfAnyCase(obj(payload.usage));
    row.lastTs = Math.max(row.lastTs, event.ts);
    perModel.set(key, row);

    const stageRow = perStage.get(stage) ?? { stage, entries: 0, usd: 0 };
    stageRow.entries += 1;
    stageRow.usd += usd;
    perStage.set(stage, stageRow);
  }

  return {
    totalUsd,
    entries,
    unknownEntries,
    sessionsWithCost: sessions.size,
    perModel: [...perModel.values()].sort((a, b) => b.usd - a.usd || b.entries - a.entries),
    perStage: [...perStage.values()].sort((a, b) => b.usd - a.usd)
  };
}

// ---- judge decisions ----

export type JudgeDecisionRow = {
  traceId: string;
  ts: number;
  decision?: string;
  selectedId?: string;
  /** Panel model behind the selected candidate/trajectory, when resolvable. */
  selectedModelId?: string;
  rationale?: string;
  synthesisEmpty: boolean;
};

export type JudgeModelStanding = {
  modelId: string;
  /** Sessions in which this model fielded a panel candidate. */
  onPanel: number;
  /** Sessions in which the judge selected this model's candidate verbatim. */
  selected: number;
};

export type JudgeRollup = {
  decisions: JudgeDecisionRow[];
  totalDecisions: number;
  synthesizeCount: number;
  selectCount: number;
  emptySynthesisCount: number;
  models: JudgeModelStanding[];
};

type JudgeTraceAcc = {
  traceId: string;
  candidateModels: Map<string, string>;
  panelModels: Set<string>;
  decision?: string;
  selectedId?: string;
  rationale?: string;
  synthesisEmpty: boolean;
  ts: number;
};

/**
 * Fold judge terminal events across sessions into decision stats: how often
 * the judge synthesizes vs selects a candidate verbatim, which panel models
 * win selections, and how often synthesis came back empty. One decision per
 * session (the last terminal judge.final that carries one).
 */
export function rollupJudge(events: StoredEvent[]): JudgeRollup {
  const traces = new Map<string, JudgeTraceAcc>();
  const ensure = (traceId: string): JudgeTraceAcc => {
    let acc = traces.get(traceId);
    if (acc === undefined) {
      acc = {
        traceId,
        candidateModels: new Map(),
        panelModels: new Set(),
        synthesisEmpty: false,
        ts: 0
      };
      traces.set(traceId, acc);
    }
    return acc;
  };

  for (const event of events) {
    const payload = obj(event.payload);
    const acc = ensure(event.trace_id);
    acc.ts = Math.max(acc.ts, event.ts);

    if (event.event_type === "harness.candidate.started") {
      if (event.candidate_id !== undefined && event.model_id !== undefined) {
        acc.candidateModels.set(event.candidate_id, event.model_id);
        acc.panelModels.add(event.model_id);
      }
    } else if (event.event_type === "judge.synthesis") {
      if (payload.empty === true) acc.synthesisEmpty = true;
    } else if (event.event_type === "judge.final") {
      // Only terminal finals that carry a decision count; the TS gateway also
      // re-traces intermediate/duplicate finals without one.
      const decision = typeof payload.decision === "string" ? payload.decision : undefined;
      if (decision !== undefined) {
        acc.decision = decision;
        acc.selectedId =
          typeof payload.selected_trajectory_id === "string"
            ? payload.selected_trajectory_id
            : undefined;
        acc.rationale = typeof payload.rationale === "string" ? payload.rationale : undefined;
      }
    }
  }

  const decisions: JudgeDecisionRow[] = [];
  const standings = new Map<string, JudgeModelStanding>();
  let synthesizeCount = 0;
  let selectCount = 0;
  let emptySynthesisCount = 0;

  for (const acc of traces.values()) {
    if (acc.decision === undefined) continue;
    const selectedModelId =
      acc.selectedId !== undefined
        ? (acc.candidateModels.get(acc.selectedId) ??
          (acc.panelModels.has(acc.selectedId) ? acc.selectedId : undefined))
        : undefined;
    decisions.push({
      traceId: acc.traceId,
      ts: acc.ts,
      decision: acc.decision,
      ...(acc.selectedId !== undefined ? { selectedId: acc.selectedId } : {}),
      ...(selectedModelId !== undefined ? { selectedModelId } : {}),
      ...(acc.rationale !== undefined ? { rationale: acc.rationale } : {}),
      synthesisEmpty: acc.synthesisEmpty
    });
    if (acc.decision === "synthesize") synthesizeCount += 1;
    else if (acc.decision === "select_trajectory") selectCount += 1;
    if (acc.synthesisEmpty) emptySynthesisCount += 1;

    for (const modelId of acc.panelModels) {
      const standing = standings.get(modelId) ?? { modelId, onPanel: 0, selected: 0 };
      standing.onPanel += 1;
      if (modelId === selectedModelId) standing.selected += 1;
      standings.set(modelId, standing);
    }
  }

  decisions.sort((a, b) => b.ts - a.ts);
  return {
    decisions,
    totalDecisions: decisions.length,
    synthesizeCount,
    selectCount,
    emptySynthesisCount,
    models: [...standings.values()].sort(
      (a, b) => b.selected - a.selected || b.onPanel - a.onPanel || a.modelId.localeCompare(b.modelId)
    )
  };
}

export type EnvironmentRollup = {
  signature: string;
  repo?: string;
  judgeModel?: string | null;
  harnesses?: string[];
  models: Array<{ id: string; model: string; provider?: string; endpointId?: string }>;
  modelEndpoints?: Record<string, string>;
  fusionBackendUrl?: string;
  sessionCount: number;
  lastTs: number;
};

export type EnvironmentInput = {
  environment: RawEnvironment | null;
  lastTs: number;
};

export function rollupEnvironments(rows: EnvironmentInput[]): EnvironmentRollup[] {
  const bySignature = new Map<string, EnvironmentRollup>();

  for (const row of rows) {
    const env = row.environment;
    if (env === null) continue;
    const models = (env.models ?? []).map((model) => ({
      id: model.id,
      model: model.model,
      ...(model.provider !== undefined ? { provider: model.provider } : {}),
      ...(model.endpoint_id !== undefined ? { endpointId: model.endpoint_id } : {})
    }));
    const signature = JSON.stringify({
      repo: env.repo ?? null,
      judge: env.judge_model ?? null,
      harnesses: env.harnesses ?? [],
      models: models.map((model) => `${model.id}:${model.model}`).sort()
    });

    const existing = bySignature.get(signature);
    if (existing !== undefined) {
      existing.sessionCount += 1;
      existing.lastTs = Math.max(existing.lastTs, row.lastTs);
      continue;
    }
    bySignature.set(signature, {
      signature,
      ...(env.repo !== undefined ? { repo: env.repo } : {}),
      judgeModel: env.judge_model ?? null,
      ...(env.harnesses !== undefined ? { harnesses: env.harnesses } : {}),
      models,
      ...(env.model_endpoints !== undefined ? { modelEndpoints: env.model_endpoints } : {}),
      ...(env.fusion_backend_url !== undefined ? { fusionBackendUrl: env.fusion_backend_url } : {}),
      sessionCount: 1,
      lastTs: row.lastTs
    });
  }

  return [...bySignature.values()].sort((a, b) => b.lastTs - a.lastTs);
}
