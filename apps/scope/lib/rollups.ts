import { attrBool, attrNum, attrStr, candidateIdOf, modelIdOf } from "./types";
import type { RawEnvironment, StoredEvent, StoredSpan } from "./types";

/**
 * Pure cross-session aggregations for the Models, Judge, and Environments
 * pages, folded from flat span and event lists. Kept dependency-free so they
 * can be unit tested directly.
 */

/** Total tokens carried by a usage blob (total, or prompt + completion). */
export function tokensOf(usage: Record<string, unknown>): number {
  if (typeof usage.total_tokens === "number") return usage.total_tokens;
  const prompt = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const completion = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
  return prompt + completion;
}

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

type ModelAcc = {
  modelId: string;
  provider?: string;
  started: Set<string>;
  finished: Set<string>;
  succeeded: number;
  failed: number;
  latencies: number[];
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  lastTs: number;
};

/**
 * Fold model-call chat spans plus their live start events into per-model
 * stats. A start event with no finished chat span is a running call; the
 * chat span carries GenAI usage, latency, and outcome.
 */
export function rollupModels(spans: StoredSpan[], events: StoredEvent[] = []): ModelRollup[] {
  const byModel = new Map<string, ModelAcc>();
  const ensure = (modelId: string): ModelAcc => {
    let acc = byModel.get(modelId);
    if (acc === undefined) {
      acc = {
        modelId,
        started: new Set(),
        finished: new Set(),
        succeeded: 0,
        failed: 0,
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
    if (event.name !== "fusion.model_call.started") continue;
    const modelId = modelIdOf(event);
    if (modelId === undefined) continue;
    const acc = ensure(modelId);
    acc.lastTs = Math.max(acc.lastTs, event.ts_ms);
    const provider = attrStr(event, "gen_ai.provider.name");
    if (provider !== undefined) acc.provider = provider;
    acc.started.add(event.span_id ?? `event-${event.id}`);
  }

  for (const span of spans) {
    const modelId = modelIdOf(span);
    if (modelId === undefined) continue;

    if (span.name.startsWith("chat")) {
      const acc = ensure(modelId);
      acc.lastTs = Math.max(acc.lastTs, span.end_ms);
      const provider = attrStr(span, "gen_ai.provider.name");
      if (provider !== undefined) acc.provider = provider;
      acc.finished.add(span.span_id);
      if (span.status === "error") acc.failed += 1;
      else acc.succeeded += 1;
      const latency = span.end_ms - span.start_ms;
      if (latency > 0) acc.latencies.push(latency / 1000);
      const prompt = attrNum(span, "gen_ai.usage.input_tokens") ?? 0;
      const completion = attrNum(span, "gen_ai.usage.output_tokens") ?? 0;
      acc.promptTokens += prompt;
      acc.completionTokens += completion;
      acc.totalTokens += prompt + completion;
    }
  }

  return [...byModel.values()]
    .map((acc): ModelRollup => {
      const calls = new Set([...acc.started, ...acc.finished]).size;
      const running = [...acc.started].filter((spanId) => !acc.finished.has(spanId)).length;
      return {
        modelId: acc.modelId,
        ...(acc.provider !== undefined ? { provider: acc.provider } : {}),
        calls,
        succeeded: acc.succeeded,
        failed: acc.failed,
        running,
        ...(acc.latencies.length > 0
          ? { avgLatencyS: acc.latencies.reduce((sum, value) => sum + value, 0) / acc.latencies.length }
          : {}),
        totalTokens: acc.totalTokens,
        promptTokens: acc.promptTokens,
        completionTokens: acc.completionTokens,
        lastTs: acc.lastTs
      };
    })
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
 * Fold the gateway cost meter's `fusion.cost` events into spend rollups.
 * Costs are attributed to the priced model name and the metering stage
 * (panel, judge_synth, passthrough).
 */
export function rollupCost(events: StoredEvent[]): CostRollup {
  const perModel = new Map<string, CostModelRow>();
  const perStage = new Map<string, { stage: string; entries: number; usd: number }>();
  const sessions = new Set<string>();
  let totalUsd = 0;
  let entries = 0;
  let unknownEntries = 0;

  for (const event of events) {
    if (event.name !== "fusion.cost") continue;
    entries += 1;
    const stage = attrStr(event, "fusion.cost.stage") ?? "unknown";
    const model = attrStr(event, "fusion.cost.model") ?? "unknown";
    const usd = attrNum(event, "fusion.cost.turn_usd") ?? 0;
    if (attrBool(event, "fusion.cost.unknown") === true) unknownEntries += 1;
    totalUsd += usd;
    if (usd > 0) sessions.add(event.trace_id);

    const prompt = attrNum(event, "gen_ai.usage.input_tokens") ?? 0;
    const completion = attrNum(event, "gen_ai.usage.output_tokens") ?? 0;

    const key = `${model}\u0000${stage}`;
    const row = perModel.get(key) ?? { model, stage, entries: 0, usd: 0, tokens: 0, lastTs: 0 };
    row.entries += 1;
    row.usd += usd;
    row.tokens += prompt + completion;
    row.lastTs = Math.max(row.lastTs, event.ts_ms);
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
 * Fold terminal judge spans (plus candidate-started and synthesis events)
 * across sessions into decision stats: how often the judge synthesizes vs
 * selects a candidate verbatim, which panel models win selections, and how
 * often synthesis came back empty. One decision per session (the last judge
 * span that carries one).
 */
export function rollupJudge(spans: StoredSpan[], events: StoredEvent[] = []): JudgeRollup {
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
    const acc = ensure(event.trace_id);
    acc.ts = Math.max(acc.ts, event.ts_ms);

    if (event.name === "fusion.candidate.started") {
      const candidateId = candidateIdOf(event);
      const modelId = attrStr(event, "fusion.model.id");
      if (candidateId !== undefined && modelId !== undefined) {
        acc.candidateModels.set(candidateId, modelId);
        acc.panelModels.add(modelId);
      }
    } else if (event.name === "fusion.judge.synthesis") {
      if (attrBool(event, "fusion.synthesis_empty") === true) acc.synthesisEmpty = true;
    }
  }

  for (const span of spans) {
    const acc = ensure(span.trace_id);
    acc.ts = Math.max(acc.ts, span.end_ms);

    if (span.name === "fusion.candidate") {
      const candidateId = candidateIdOf(span);
      const modelId = attrStr(span, "fusion.model.id");
      if (candidateId !== undefined && modelId !== undefined) {
        acc.candidateModels.set(candidateId, modelId);
        acc.panelModels.add(modelId);
      }
    } else if (span.name === "fusion.judge" || span.name === "fusion.fuse") {
      const decision = attrStr(span, "fusion.decision");
      if (decision !== undefined) {
        acc.decision = decision;
        acc.selectedId = attrStr(span, "fusion.selected.trajectory_id");
        acc.rationale = attrStr(span, "fusion.rationale");
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
