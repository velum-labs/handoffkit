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
  lastTs: number;
};

function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function tokensOf(usage: Record<string, unknown>): number {
  if (typeof usage.total_tokens === "number") return usage.total_tokens;
  const prompt = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const completion = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
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
      acc.totalTokens += tokensOf(obj(payload.usage));
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
      lastTs: acc.lastTs
    }))
    .sort((a, b) => b.calls - a.calls || b.lastTs - a.lastTs);
}

export type EnvironmentRollup = {
  signature: string;
  repo?: string;
  judgeModel?: string | null;
  harnesses?: string[];
  models: Array<{ id: string; model: string }>;
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
    const models = (env.models ?? []).map((model) => ({ id: model.id, model: model.model }));
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
      ...(env.fusion_backend_url !== undefined ? { fusionBackendUrl: env.fusion_backend_url } : {}),
      sessionCount: 1,
      lastTs: row.lastTs
    });
  }

  return [...bySignature.values()].sort((a, b) => b.lastTs - a.lastTs);
}
