import type { BudgetLedger, OperatorGraph, OutcomeRecord, RuntimeExecutionResult, RuntimeReplayRecord, RuntimeStatus, Scheduler, TraceEvent } from "./types.js";
export type { OutcomeRecord, RuntimeReplayRecord } from "./types.js";
import { cloneBudgetLedger } from "./budget.js";

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value) || isPlainObject(value)) {
    for (const child of Object.values(value)) deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

export function createRuntimeReplayRecord(result: RuntimeExecutionResult): RuntimeReplayRecord {
  return deepFreeze({
    schema: "fusion-runtime-replay.v1",
    runId: result.runId,
    graph: result.graph,
    scheduler: {
      id: result.scheduler.id,
      family: result.scheduler.family
    },
    artifacts: [...result.artifacts],
    observations: [...result.observations],
    signals: [...result.signals],
    trace: [...result.trace],
    outcome: result.outcome
  });
}

export function runtimeReplayRecordJson(record: RuntimeReplayRecord): string {
  return JSON.stringify(record, null, 2) + "\n";
}

export function buildOutcome(now: () => number, input: {
  runId: string;
  graph: OperatorGraph;
  scheduler: Scheduler;
  taskArtifactIds: string[];
  finalArtifactIds: string[];
  observationIds: string[];
  signalIds: string[];
  privateObservationIds: string[];
  privateSignalIds: string[];
  trace: readonly TraceEvent[];
  budget: BudgetLedger;
  startedAt: string;
  status: RuntimeStatus;
  error?: string;
  metadata?: Record<string, unknown>;
  operatorSummaries?: OutcomeRecord["operatorSummaries"];
  availableSignalIds?: string[];
  selectedArtifactIds?: string[];
}): OutcomeRecord {
const finishedAt = new Date(now()).toISOString();
  return {
    id: `${input.runId}.outcome`,
    runId: input.runId,
    graphId: input.graph.id,
    schedulerId: input.scheduler.id,
    schedulerFamily: input.scheduler.family,
    status: input.status,
    taskArtifactIds: [...input.taskArtifactIds],
    finalArtifactIds: [...input.finalArtifactIds],
    observationIds: [...input.observationIds],
    signalIds: [...input.signalIds],
    privateObservationIds: [...input.privateObservationIds],
    privateSignalIds: [...input.privateSignalIds],
    traceEventIds: input.trace.map((event) => event.id),
    budget: cloneBudgetLedger(input.budget),
    startedAt: input.startedAt,
    finishedAt,
    ...(input.error !== undefined ? { error: input.error } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    ...(input.operatorSummaries !== undefined ? { operatorSummaries: input.operatorSummaries } : {}),
    ...(input.availableSignalIds !== undefined ? { availableSignalIds: [...input.availableSignalIds] } : {}),
    ...(input.selectedArtifactIds !== undefined ? { selectedArtifactIds: [...input.selectedArtifactIds] } : {})
  };
}
