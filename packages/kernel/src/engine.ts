import { validateOperatorGraph } from "./graph-validation.js";
import { terminalNodeIds } from "./graph-utils.js";
import { budgetMessage, cloneBudgetLedger, costOf, isRetryable, usageWithDefaults } from "./budget.js";
import { streamRuntime } from "./streaming.js";
import { buildOutcome } from "./outcome.js";
import { createArtifact, deepFreeze } from "./runtime-artifacts.js";
import {
  isPrivateLeakage,
  maxLeakage,
  schedulerVisibleArtifact,
  schedulerVisibleObservation,
  schedulerVisibleSignal
} from "./visibility.js";
import type {
  Artifact,
  ArtifactLeakage,
  BudgetLedger,
  BudgetPolicy,
  BudgetUsage,
  CreateArtifactInput,
  Observation,
  ObservationFilter,
  OperatorGraph,
  OperatorGraphNode,
  OperatorRunContext,
  OperatorSpec,
  OutcomeRecord,
  RuntimeEvent,
  RuntimeExecutionResult,
  RuntimeStatus,
  Scheduler,
  SchedulerExecutionContext,
  Signal,
  SignalFilter,
  StreamingOperator,
  TraceEvent,
  TraceEventInput
} from "./types.js";
import {
  BudgetExceededError,
  OperatorGraphError,
  RuntimeCancelledError,
  RuntimeExecutionError
} from "./types.js";

export { createRuntimeReplayRecord, runtimeReplayRecordJson } from "./outcome.js";
export { createArtifact } from "./runtime-artifacts.js";
export { DirectFastPathScheduler, StaticDAGScheduler } from "./scheduling.js";
export type * from "./types.js";
export {
  InMemoryKernelStateStore,
  BudgetExceededError,
  OperatorGraphError,
  RuntimeCancelledError,
  RuntimeExecutionError
} from "./types.js";

type RuntimeCounters = {
  artifact: number;
  observation: number;
  signal: number;
  trace: number;
};

type RuntimeStore = {
  artifacts: Map<string, Artifact>;
  observations: Map<string, Observation>;
  signals: Map<string, Signal>;
  nodeOutputs: Map<string, string[]>;
  trace: TraceEvent[];
};

function operatorInputTypesSatisfied(spec: OperatorSpec, inputs: readonly Artifact[]): boolean {
  for (const type of spec.requiredInputTypes ?? spec.inputTypes ?? []) {
    if (!inputs.some((artifact) => artifact.type === type)) return false;
  }
  return true;
}

function validateGraph(graph: OperatorGraph): void {
  const errors = validateOperatorGraph(graph).filter((issue) => issue.severity === "error");
  if (errors.length > 0) throw new OperatorGraphError(errors.map((issue) => issue.message).join("; "));
}

export class FusionRuntime {
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  stream(input: {
    graph: OperatorGraph;
    scheduler: Scheduler;
    artifacts?: readonly Artifact[];
    budget?: BudgetPolicy;
    runId?: string;
    signal?: AbortSignal;
    metadata?: Record<string, unknown>;
  }): AsyncIterable<RuntimeEvent> {
    return streamRuntime((runInput, streamOptions) => this.run(runInput, streamOptions), input);
  }

  async run(
    input: {
      graph: OperatorGraph;
      scheduler: Scheduler;
      artifacts?: readonly Artifact[];
      budget?: BudgetPolicy;
      runId?: string;
      signal?: AbortSignal;
      failureMode?: "throw" | "return";
      metadata?: Record<string, unknown>;
    },
    streamOptions?: { sink: (event: RuntimeEvent) => void }
  ): Promise<RuntimeExecutionResult> {
    validateGraph(input.graph);
    const runId = input.runId ?? `run_${this.#now().toString(36)}`;
    const startedAtMs = this.#now();
    const startedAt = new Date(startedAtMs).toISOString();
    const budget = input.budget ?? {};
    const ledger: BudgetLedger = {
      operatorRuns: 0,
      artifacts: input.artifacts?.length ?? 0,
      candidates: 0,
      costUsd: 0,
      reservedCostUsd: 0,
      actualCostUsd: 0,
      inputTokens: 0,
      reservedInputTokens: 0,
      actualInputTokens: 0,
      outputTokens: 0,
      reservedOutputTokens: 0,
      actualOutputTokens: 0,
      toolCalls: 0,
      reservedToolCalls: 0,
      actualToolCalls: 0,
      reservedCandidates: 0,
      actualCandidates: 0,
      workspaceWriters: 0,
      startedAt,
      elapsedMs: 0
    };
    const counters: RuntimeCounters = { artifact: 0, observation: 0, signal: 0, trace: 0 };
    const store: RuntimeStore = {
      artifacts: new Map(),
      observations: new Map(),
      signals: new Map(),
      nodeOutputs: new Map(),
      trace: []
    };
    const operatorSummaries: NonNullable<OutcomeRecord["operatorSummaries"]> = [];
    const recordTrace = (event: TraceEventInput): TraceEvent => {
      const traceEvent: TraceEvent = Object.freeze({
        ...event,
        id: `${runId}.trace.${++counters.trace}`,
        runId,
        graphId: input.graph.id,
        timestamp: new Date(this.#now()).toISOString()
      });
      store.trace.push(traceEvent);
      return traceEvent;
    };
    for (const artifact of input.artifacts ?? []) {
      if (store.artifacts.has(artifact.id)) throw new OperatorGraphError(`duplicate artifact id: ${artifact.id}`);
      store.artifacts.set(artifact.id, deepFreeze(artifact));
    }
    recordTrace({
      type: "runtime.started",
      payload: { scheduler_id: input.scheduler.id, scheduler_family: input.scheduler.family }
    });

    const updateElapsed = (): void => {
      ledger.elapsedMs = Math.max(0, this.#now() - startedAtMs);
    };
    const throwIfAborted = (): void => {
      if (input.signal?.aborted) throw new RuntimeCancelledError();
    };
    const ensureUsageBudget = (usage: BudgetUsage, operatorId?: string): void => {
      updateElapsed();
      const projected = usageWithDefaults(usage);
      if (budget.maxCostUsd !== undefined && ledger.costUsd + projected.usd > budget.maxCostUsd) {
        recordTrace({ type: "budget.exceeded", ...(operatorId !== undefined ? { operatorId } : {}), payload: { limit: "maxCostUsd" } });
        throw new BudgetExceededError(budgetMessage(`cost ${ledger.costUsd + projected.usd} > ${budget.maxCostUsd}`, budget));
      }
      if (budget.maxInputTokens !== undefined && ledger.inputTokens + projected.inputTokens > budget.maxInputTokens) {
        recordTrace({ type: "budget.exceeded", ...(operatorId !== undefined ? { operatorId } : {}), payload: { limit: "maxInputTokens" } });
        throw new BudgetExceededError(
          budgetMessage(`input tokens ${ledger.inputTokens + projected.inputTokens} > ${budget.maxInputTokens}`, budget)
        );
      }
      if (budget.maxOutputTokens !== undefined && ledger.outputTokens + projected.outputTokens > budget.maxOutputTokens) {
        recordTrace({ type: "budget.exceeded", ...(operatorId !== undefined ? { operatorId } : {}), payload: { limit: "maxOutputTokens" } });
        throw new BudgetExceededError(
          budgetMessage(`output tokens ${ledger.outputTokens + projected.outputTokens} > ${budget.maxOutputTokens}`, budget)
        );
      }
      if (budget.maxCandidates !== undefined && ledger.candidates + projected.candidates > budget.maxCandidates) {
        recordTrace({ type: "budget.exceeded", ...(operatorId !== undefined ? { operatorId } : {}), payload: { limit: "maxCandidates" } });
        throw new BudgetExceededError(
          budgetMessage(`candidates ${ledger.candidates + projected.candidates} > ${budget.maxCandidates}`, budget)
        );
      }
      if (budget.maxToolCalls !== undefined && ledger.toolCalls + projected.toolCalls > budget.maxToolCalls) {
        recordTrace({ type: "budget.exceeded", ...(operatorId !== undefined ? { operatorId } : {}), payload: { limit: "maxToolCalls" } });
        throw new BudgetExceededError(
          budgetMessage(`tool calls ${ledger.toolCalls + projected.toolCalls} > ${budget.maxToolCalls}`, budget)
        );
      }
    };
    const consumeBudget = (usage: BudgetUsage, operatorId?: string): void => {
      ensureUsageBudget(usage, operatorId);
      const actual = usageWithDefaults(usage);
      const reconciledCost = Math.min(ledger.reservedCostUsd, actual.usd);
      const reconciledInput = Math.min(ledger.reservedInputTokens, actual.inputTokens);
      const reconciledOutput = Math.min(ledger.reservedOutputTokens, actual.outputTokens);
      const reconciledCandidates = Math.min(ledger.reservedCandidates, actual.candidates);
      const reconciledToolCalls = Math.min(ledger.reservedToolCalls, actual.toolCalls);
      ledger.reservedCostUsd -= reconciledCost;
      ledger.reservedInputTokens -= reconciledInput;
      ledger.reservedOutputTokens -= reconciledOutput;
      ledger.reservedCandidates -= reconciledCandidates;
      ledger.reservedToolCalls -= reconciledToolCalls;
      ledger.actualCostUsd += actual.usd;
      ledger.actualInputTokens += actual.inputTokens;
      ledger.actualOutputTokens += actual.outputTokens;
      ledger.actualCandidates += actual.candidates;
      ledger.actualToolCalls += actual.toolCalls;
      ledger.costUsd += actual.usd - reconciledCost;
      ledger.inputTokens += actual.inputTokens - reconciledInput;
      ledger.outputTokens += actual.outputTokens - reconciledOutput;
      ledger.candidates += actual.candidates - reconciledCandidates;
      ledger.toolCalls += actual.toolCalls - reconciledToolCalls;
      recordTrace({
        type: "budget.consumed",
        ...(operatorId !== undefined ? { operatorId } : {}),
        payload: {
          cost_usd: actual.usd,
          input_tokens: actual.inputTokens,
          output_tokens: actual.outputTokens,
          candidates: actual.candidates,
          tool_calls: actual.toolCalls
        }
      });
    };
    const ensureBudget = (spec: OperatorSpec): void => {
      updateElapsed();
      if (budget.maxLatencyMs !== undefined && ledger.elapsedMs > budget.maxLatencyMs) {
        recordTrace({ type: "budget.exceeded", payload: { limit: "maxLatencyMs", elapsed_ms: ledger.elapsedMs } });
        throw new BudgetExceededError(budgetMessage(`latency ${ledger.elapsedMs}ms > ${budget.maxLatencyMs}ms`, budget));
      }
      if (budget.maxOperatorRuns !== undefined && ledger.operatorRuns + 1 > budget.maxOperatorRuns) {
        recordTrace({ type: "budget.exceeded", payload: { limit: "maxOperatorRuns" } });
        throw new BudgetExceededError(
          budgetMessage(`operator runs ${ledger.operatorRuns + 1} > ${budget.maxOperatorRuns}`, budget)
        );
      }
      if (budget.allowedSideEffects !== undefined && !budget.allowedSideEffects.includes(spec.sideEffects)) {
        recordTrace({
          type: "budget.exceeded",
          operatorId: spec.id,
          payload: { limit: "allowedSideEffects", side_effects: spec.sideEffects }
        });
        throw new BudgetExceededError(budgetMessage(`side effect ${spec.sideEffects} is not allowed`, budget));
      }
      const expected = costOf(spec);
      if ((budget.expectedCostPolicy ?? "reserve") === "reserve") {
        ensureUsageBudget(expected, spec.id);
      }
      if (
        budget.maxWorkspaceWriters !== undefined &&
        spec.sideEffects === "write_workspace" &&
        ledger.workspaceWriters + 1 > budget.maxWorkspaceWriters
      ) {
        recordTrace({ type: "budget.exceeded", operatorId: spec.id, payload: { limit: "maxWorkspaceWriters" } });
        throw new BudgetExceededError(
          budgetMessage(`workspace writers ${ledger.workspaceWriters + 1} > ${budget.maxWorkspaceWriters}`, budget)
        );
      }
    };
    const resolveInputs = (node: OperatorGraphNode): readonly Artifact[] => {
      const refs = node.inputs ?? [];
      const resolved: Artifact[] = [];
      const ensureArtifactAllowed = (artifact: Artifact): void => {
        const allowedLeakage = node.operator.spec.allowedInputLeakage ?? ["none", "public"];
        if (artifact.visibility === "private_eval" || isPrivateLeakage(artifact.leakage)) {
          if (budget.allowPrivateRuntimeInputs !== true) {
            throw new OperatorGraphError(
              `node ${node.id} cannot consume private/contaminated artifact ${artifact.id} without private runtime input budget permission`
            );
          }
          if (!allowedLeakage.includes(artifact.leakage)) {
            throw new OperatorGraphError(
              `node ${node.id} cannot consume ${artifact.leakage} artifact ${artifact.id} without operator leakage permission`
            );
          }
          return;
        }
        if (!allowedLeakage.includes(artifact.leakage)) {
          throw new OperatorGraphError(`node ${node.id} cannot consume ${artifact.leakage} artifact ${artifact.id}`);
        }
      };
      for (const ref of refs) {
        if ("artifactId" in ref) {
          const artifact = store.artifacts.get(ref.artifactId);
          if (artifact === undefined) {
            throw new OperatorGraphError(`node ${node.id} references missing artifact ${ref.artifactId}`);
          }
          ensureArtifactAllowed(artifact);
          resolved.push(artifact);
        } else {
          const outputIds = store.nodeOutputs.get(ref.nodeId);
          if (outputIds === undefined) {
            throw new OperatorGraphError(`node ${node.id} references unfinished node ${ref.nodeId}`);
          }
          for (const artifactId of outputIds) {
            const artifact = store.artifacts.get(artifactId);
            if (artifact !== undefined && (ref.type === undefined || artifact.type === ref.type)) {
              ensureArtifactAllowed(artifact);
              resolved.push(artifact);
            }
          }
        }
      }
      return Object.freeze(resolved);
    };
    const runNode = async (node: OperatorGraphNode): Promise<readonly Artifact[]> => {
      throwIfAborted();
      const inputs = resolveInputs(node);
      if (!operatorInputTypesSatisfied(node.operator.spec, inputs)) {
        throw new OperatorGraphError(
          `node ${node.id} operator ${node.operator.spec.id} missing required input artifact type`
        );
      }
      ensureBudget(node.operator.spec);
      const expected = costOf(node.operator.spec);
      ledger.operatorRuns += 1;
      if ((budget.expectedCostPolicy ?? "reserve") === "reserve") {
        ledger.costUsd += expected.usd ?? 0;
        ledger.reservedCostUsd += expected.usd ?? 0;
        ledger.inputTokens += expected.inputTokens ?? 0;
        ledger.reservedInputTokens += expected.inputTokens ?? 0;
        ledger.outputTokens += expected.outputTokens ?? 0;
        ledger.reservedOutputTokens += expected.outputTokens ?? 0;
        ledger.candidates += expected.candidates ?? 0;
        ledger.reservedCandidates += expected.candidates ?? 0;
        ledger.toolCalls += expected.toolCalls ?? 0;
        ledger.reservedToolCalls += expected.toolCalls ?? 0;
      }
      if (node.operator.spec.sideEffects === "write_workspace") ledger.workspaceWriters += 1;
      const inputArtifactIds = inputs.map((artifact) => artifact.id);
      recordTrace({
        type: "operator.started",
        nodeId: node.id,
        operatorId: node.operator.spec.id,
        inputArtifactIds,
        payload: {
          kind: node.operator.spec.kind,
          side_effects: node.operator.spec.sideEffects
        }
      });
      const operatorContext: OperatorRunContext = {
        runId,
        graphId: input.graph.id,
        nodeId: node.id,
        operator: node.operator.spec,
        budget,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
        getArtifact: (id) => store.artifacts.get(id),
        getObservation: (id) => {
          const observation = store.observations.get(id);
          return observation !== undefined && schedulerVisibleObservation(observation) ? observation : undefined;
        },
        getSignal: (id) => {
          const signal = store.signals.get(id);
          return signal !== undefined && schedulerVisibleSignal(signal) ? signal : undefined;
        },
        visibleObservations: (filter = {}) =>
          Object.freeze(
            [...store.observations.values()].filter(
              (observation) =>
                schedulerVisibleObservation(observation) &&
                (filter.targetArtifactId === undefined || observation.targetArtifactId === filter.targetArtifactId) &&
                (filter.sourceId === undefined || observation.sourceId === filter.sourceId) &&
                (filter.type === undefined || observation.type === filter.type)
            )
          ),
        visibleSignals: (filter = {}) =>
          Object.freeze(
            [...store.signals.values()].filter(
              (signal) =>
                schedulerVisibleSignal(signal) &&
                (filter.targetArtifactId === undefined || signal.targetArtifactId === filter.targetArtifactId) &&
                (filter.dimension === undefined || signal.dimension === filter.dimension)
            )
          ),
        createArtifact: <T = unknown>(artifactInput: CreateArtifactInput<T>): Artifact<T> =>
          createArtifact({
            ...artifactInput,
            id: artifactInput.id ?? `${node.operator.spec.id}.artifact.${++counters.artifact}`,
            provenance: {
              ...artifactInput.provenance,
              runId,
              graphId: input.graph.id,
              createdByOperatorId: node.operator.spec.id,
              createdByOperatorKind: node.operator.spec.kind,
              inputArtifactIds: artifactInput.provenance?.inputArtifactIds ?? inputArtifactIds,
              createdAt: artifactInput.provenance?.createdAt ?? new Date(this.#now()).toISOString()
            }
          }),
        consumeBudget: (usage) => consumeBudget(usage, node.operator.spec.id),
        recordObservation: (observationInput) => {
          const observation: Observation = deepFreeze({
            id: observationInput.id ?? `${node.operator.spec.id}.observation.${++counters.observation}`,
            sourceId: observationInput.sourceId,
            ...(observationInput.targetArtifactId !== undefined
              ? { targetArtifactId: observationInput.targetArtifactId }
              : {}),
            type: observationInput.type,
            value: deepFreeze(observationInput.value),
            leakage: observationInput.leakage ?? "public",
            visibility: observationInput.visibility ?? "runtime",
            createdAt: new Date(this.#now()).toISOString(),
            ...(observationInput.metadata !== undefined ? { metadata: observationInput.metadata } : {})
          });
          if (store.observations.has(observation.id)) {
            throw new OperatorGraphError(`duplicate observation id: ${observation.id}`);
          }
          if (
            observation.targetArtifactId !== undefined &&
            store.artifacts.get(observation.targetArtifactId) === undefined
          ) {
            throw new OperatorGraphError(
              `observation ${observation.id} references missing artifact ${observation.targetArtifactId}`
            );
          }
          store.observations.set(observation.id, observation);
          recordTrace({
            type: "observation.recorded",
            nodeId: node.id,
            operatorId: node.operator.spec.id,
            ...(observation.targetArtifactId !== undefined ? { outputArtifactIds: [observation.targetArtifactId] } : {}),
            payload: {
              observation_id: observation.id,
              source_id: observation.sourceId,
              observation_type: observation.type,
              leakage: observation.leakage,
              visibility: observation.visibility
            }
          });
          return observation;
        },
        recordSignal: (signalInput) => {
          if (signalInput.score < 0 || signalInput.score > 1) {
            throw new OperatorGraphError(`signal ${signalInput.id ?? "(new)"} score must be between 0 and 1`);
          }
          if (signalInput.confidence < 0 || signalInput.confidence > 1) {
            throw new OperatorGraphError(`signal ${signalInput.id ?? "(new)"} confidence must be between 0 and 1`);
          }
          if (store.artifacts.get(signalInput.targetArtifactId) === undefined) {
            throw new OperatorGraphError(
              `signal ${signalInput.id ?? "(new)"} references missing artifact ${signalInput.targetArtifactId}`
            );
          }
          const observationIds = [...(signalInput.observationIds ?? [])];
          const observationLeakage: ArtifactLeakage[] = [];
          for (const observationId of observationIds) {
            const observation = store.observations.get(observationId);
            if (observation === undefined) {
              throw new OperatorGraphError(`signal ${signalInput.id ?? "(new)"} references missing observation ${observationId}`);
            }
            observationLeakage.push(observation.leakage);
          }
          const requestedLeakage = signalInput.leakageRisk ?? "public";
          const effectiveLeakage = maxLeakage([requestedLeakage, ...observationLeakage]);
          const signal: Signal = deepFreeze({
            id: signalInput.id ?? `${node.operator.spec.id}.signal.${++counters.signal}`,
            targetArtifactId: signalInput.targetArtifactId,
            dimension: signalInput.dimension,
            score: signalInput.score,
            confidence: signalInput.confidence,
            calibration: signalInput.calibration,
            leakageRisk: effectiveLeakage,
            observationIds,
            createdAt: new Date(this.#now()).toISOString(),
            ...(signalInput.metadata !== undefined ? { metadata: signalInput.metadata } : {})
          });
          if (store.signals.has(signal.id)) throw new OperatorGraphError(`duplicate signal id: ${signal.id}`);
          store.signals.set(signal.id, signal);
          recordTrace({
            type: "signal.recorded",
            nodeId: node.id,
            operatorId: node.operator.spec.id,
            outputArtifactIds: [signal.targetArtifactId],
            payload: {
              signal_id: signal.id,
              dimension: signal.dimension,
              score: signal.score,
              confidence: signal.confidence,
              calibration: signal.calibration,
              leakage_risk: signal.leakageRisk,
              observation_ids: signal.observationIds
            }
          });
          return signal;
        },
        recordTrace
      };
      const streamingOperator = node.operator as StreamingOperator;
      if (streamOptions !== undefined && typeof streamingOperator.stream === "function") {
        for await (const event of streamingOperator.stream(inputs, operatorContext)) {
          if (event.type === "final" || event.type === "error") continue;
          streamOptions.sink(event);
        }
      }
      const retry = node.operator.spec.retry ?? { maxAttempts: 1 };
      let outputs: readonly Artifact[] | undefined;
      let attempt = 0;
      for (;;) {
        throwIfAborted();
        attempt += 1;
        try {
          outputs = await node.operator.run(inputs, operatorContext);
          break;
        } catch (error) {
          if (attempt >= retry.maxAttempts || !isRetryable(error, retry)) throw error;
          recordTrace({
            type: "operator.retry",
            nodeId: node.id,
            operatorId: node.operator.spec.id,
            inputArtifactIds,
            payload: {
              attempt,
              max_attempts: retry.maxAttempts,
              error: error instanceof Error ? error.message : String(error)
            }
          });
        }
      }
      const outputIds: string[] = [];
      for (const artifact of outputs) {
        if (store.artifacts.has(artifact.id)) throw new OperatorGraphError(`duplicate artifact id: ${artifact.id}`);
        if (!node.operator.spec.outputTypes.includes(artifact.type)) {
          throw new OperatorGraphError(
            `operator ${node.operator.spec.id} emitted unsupported artifact type ${artifact.type}`
          );
        }
        store.artifacts.set(artifact.id, deepFreeze(artifact));
        outputIds.push(artifact.id);
        recordTrace({
          type: "artifact.created",
          nodeId: node.id,
          operatorId: node.operator.spec.id,
          outputArtifactIds: [artifact.id],
          payload: {
            artifact_type: artifact.type,
            visibility: artifact.visibility,
            leakage: artifact.leakage,
            provenance: artifact.provenance
          }
        });
      }
      store.nodeOutputs.set(node.id, outputIds);
      ledger.artifacts = store.artifacts.size;
      if (expected.candidates === undefined) {
        const outputCandidates = outputs.filter((artifact) => artifact.type === "candidate").length;
        if (outputCandidates > 0) consumeBudget({ candidates: outputCandidates }, node.operator.spec.id);
      }
      updateElapsed();
      if (budget.maxArtifacts !== undefined && ledger.artifacts > budget.maxArtifacts) {
        recordTrace({ type: "budget.exceeded", operatorId: node.operator.spec.id, payload: { limit: "maxArtifacts" } });
        throw new BudgetExceededError(budgetMessage(`artifacts ${ledger.artifacts} > ${budget.maxArtifacts}`, budget));
      }
      recordTrace({
        type: "operator.finished",
        nodeId: node.id,
        operatorId: node.operator.spec.id,
        inputArtifactIds,
        outputArtifactIds: outputIds,
        payload: {
          artifact_count: outputIds.length,
          elapsed_ms: ledger.elapsedMs
        }
      });
      operatorSummaries.push({
        nodeId: node.id,
        operatorId: node.operator.spec.id,
        kind: node.operator.spec.kind,
        inputArtifactIds,
        outputArtifactIds: outputIds
      });
      return Object.freeze(outputs.map((artifact) => store.artifacts.get(artifact.id) ?? artifact));
    };
    const schedulerContext: SchedulerExecutionContext = {
      runId,
      graphId: input.graph.id,
      budget,
      state: () => ({
        artifactIds: [...store.artifacts.values()].filter(schedulerVisibleArtifact).map((artifact) => artifact.id),
        nodeOutputs: Object.fromEntries(
          [...store.nodeOutputs.entries()].map(([key, value]) => [
            key,
            value.filter((artifactId) => {
              const artifact = store.artifacts.get(artifactId);
              return artifact !== undefined && schedulerVisibleArtifact(artifact);
            })
          ])
        ),
        observationIds: [...store.observations.values()]
          .filter(schedulerVisibleObservation)
          .map((observation) => observation.id),
        signalIds: [...store.signals.values()].filter(schedulerVisibleSignal).map((signal) => signal.id),
        budget: cloneBudgetLedger(ledger)
      }),
      nodeOutputIds: (nodeId) => Object.freeze([...(store.nodeOutputs.get(nodeId) ?? [])]),
      observationIds: () =>
        Object.freeze(
          [...store.observations.values()].filter(schedulerVisibleObservation).map((observation) => observation.id)
        ),
      signalIds: () =>
        Object.freeze([...store.signals.values()].filter(schedulerVisibleSignal).map((signal) => signal.id)),
      getObservation: (id) => {
        const observation = store.observations.get(id);
        return observation !== undefined && schedulerVisibleObservation(observation) ? observation : undefined;
      },
      getSignal: (id) => {
        const signal = store.signals.get(id);
        return signal !== undefined && schedulerVisibleSignal(signal) ? signal : undefined;
      },
      visibleObservations: (filter = {}) =>
        Object.freeze(
          [...store.observations.values()].filter(
            (observation) =>
              schedulerVisibleObservation(observation) &&
              (filter.targetArtifactId === undefined || observation.targetArtifactId === filter.targetArtifactId) &&
              (filter.sourceId === undefined || observation.sourceId === filter.sourceId) &&
              (filter.type === undefined || observation.type === filter.type)
          )
        ),
      visibleSignals: (filter = {}) =>
        Object.freeze(
          [...store.signals.values()].filter(
            (signal) =>
              schedulerVisibleSignal(signal) &&
              (filter.targetArtifactId === undefined || signal.targetArtifactId === filter.targetArtifactId) &&
              (filter.dimension === undefined || signal.dimension === filter.dimension)
          )
        ),
      resolveInputs,
      runNode,
      recordTrace
    };

    let finalArtifactIds: string[] = [];
    let status: RuntimeStatus = "succeeded";
    let errorMessage: string | undefined;
    try {
      const schedulerResult = await input.scheduler.schedule(input.graph, schedulerContext);
      finalArtifactIds =
        input.graph.outputArtifactIds ??
        schedulerResult.finalArtifactIds ??
        terminalNodeIds(input.graph).flatMap((nodeId) => store.nodeOutputs.get(nodeId) ?? []);
      updateElapsed();
    } catch (error) {
      status = error instanceof RuntimeCancelledError ? "cancelled" : "failed";
      errorMessage = error instanceof Error ? error.message : String(error);
      updateElapsed();
      recordTrace({
        type: "runtime.finished",
        payload: { status, error: errorMessage }
      });
      const failedOutcome = this.#outcome({
        runId,
        graph: input.graph,
        scheduler: input.scheduler,
        taskArtifactIds: input.graph.inputArtifactIds ?? [],
        finalArtifactIds: [],
        observationIds: [...store.observations.values()]
          .filter(schedulerVisibleObservation)
          .map((observation) => observation.id),
        signalIds: [...store.signals.values()].filter(schedulerVisibleSignal).map((signal) => signal.id),
        privateObservationIds: [...store.observations.values()]
          .filter((observation) => !schedulerVisibleObservation(observation))
          .map((observation) => observation.id),
        privateSignalIds: [...store.signals.values()]
          .filter((signal) => !schedulerVisibleSignal(signal))
          .map((signal) => signal.id),
        trace: store.trace,
        budget: ledger,
        startedAt,
        status,
        ...(errorMessage !== undefined ? { error: errorMessage } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
        operatorSummaries,
        availableSignalIds: [...store.signals.values()].filter(schedulerVisibleSignal).map((signal) => signal.id)
      });
      Object.freeze(failedOutcome);
      const failedResult = Object.freeze({
        runId,
        graph: input.graph,
        scheduler: input.scheduler,
        artifacts: Object.freeze([...store.artifacts.values()]),
        observations: Object.freeze([...store.observations.values()]),
        signals: Object.freeze([...store.signals.values()]),
        finalArtifacts: Object.freeze([]),
        trace: Object.freeze([...store.trace]),
        outcome: Object.freeze(failedOutcome)
      });
      if (input.failureMode === "return") return failedResult;
      throw new RuntimeExecutionError({
        message: errorMessage,
        outcome: failedOutcome,
        trace: failedResult.trace,
        artifacts: failedResult.artifacts,
        observations: failedResult.observations,
        signals: failedResult.signals,
        cause: error
      });
    }

    recordTrace({
      type: "runtime.finished",
      outputArtifactIds: finalArtifactIds,
      payload: { status }
    });
    const outcome = this.#outcome({
      runId,
      graph: input.graph,
      scheduler: input.scheduler,
      taskArtifactIds: input.graph.inputArtifactIds ?? [],
      finalArtifactIds,
      observationIds: [...store.observations.values()]
        .filter(schedulerVisibleObservation)
        .map((observation) => observation.id),
      signalIds: [...store.signals.values()].filter(schedulerVisibleSignal).map((signal) => signal.id),
      privateObservationIds: [...store.observations.values()]
        .filter((observation) => !schedulerVisibleObservation(observation))
        .map((observation) => observation.id),
      privateSignalIds: [...store.signals.values()]
        .filter((signal) => !schedulerVisibleSignal(signal))
        .map((signal) => signal.id),
      trace: store.trace,
      budget: ledger,
      startedAt,
      status,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      operatorSummaries,
      availableSignalIds: [...store.signals.values()].filter(schedulerVisibleSignal).map((signal) => signal.id),
      selectedArtifactIds: finalArtifactIds
    });
    return Object.freeze({
      runId,
      graph: input.graph,
      scheduler: input.scheduler,
      artifacts: Object.freeze([...store.artifacts.values()]),
      observations: Object.freeze([...store.observations.values()]),
      signals: Object.freeze([...store.signals.values()]),
      finalArtifacts: Object.freeze(finalArtifactIds.map((id) => store.artifacts.get(id)).filter(isArtifact)),
      trace: Object.freeze([...store.trace]),
      outcome: Object.freeze(outcome)
    });
  }

  #outcome(input: Parameters<typeof buildOutcome>[1]): OutcomeRecord {
    return buildOutcome(this.#now, input);
  }
}

function isArtifact(value: Artifact | undefined): value is Artifact {
  return value !== undefined;
}

