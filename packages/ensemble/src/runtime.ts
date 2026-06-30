export type ArtifactVisibility = "runtime" | "developer" | "user" | "private_eval";

export type ArtifactLeakage = "none" | "public" | "private" | "contaminated";

export type OperatorSideEffects = "none" | "read_workspace" | "write_workspace" | "external_tool";

export type RuntimeStatus = "succeeded" | "failed" | "cancelled";

export type TaskSpec = {
  id?: string;
  prompt?: string;
  messages?: Array<{ role: string; content: unknown }>;
  taskClass?: "chat" | "code" | "research" | "structured" | "tool_use" | "back_office";
  constraints?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type CostEstimate = {
  usd?: number;
  inputTokens?: number;
  outputTokens?: number;
  candidates?: number;
  toolCalls?: number;
};

export type BudgetUsage = CostEstimate;

export type SignalDimension = "correctness" | "coverage" | "safety" | "format" | "latency" | "cost";

export type SignalCalibration = "ground_truth" | "empirical" | "heuristic" | "llm_judge" | "unknown";

export type Observation = {
  id: string;
  sourceId: string;
  targetArtifactId?: string;
  type: string;
  value: unknown;
  leakage: ArtifactLeakage;
  visibility: ArtifactVisibility;
  createdAt: string;
  metadata?: Record<string, unknown>;
};

export type Signal = {
  id: string;
  targetArtifactId: string;
  dimension: SignalDimension;
  score: number;
  confidence: number;
  calibration: SignalCalibration;
  leakageRisk: ArtifactLeakage;
  observationIds: string[];
  createdAt: string;
  metadata?: Record<string, unknown>;
};

export type RecordObservationInput = {
  id?: string;
  sourceId: string;
  targetArtifactId?: string;
  type: string;
  value: unknown;
  leakage?: ArtifactLeakage;
  visibility?: ArtifactVisibility;
  metadata?: Record<string, unknown>;
};

export type RecordSignalInput = {
  id?: string;
  targetArtifactId: string;
  dimension: SignalDimension;
  score: number;
  confidence: number;
  calibration: SignalCalibration;
  leakageRisk?: ArtifactLeakage;
  observationIds?: string[];
  metadata?: Record<string, unknown>;
};

export type Provenance = {
  runId?: string;
  graphId?: string;
  createdByOperatorId?: string;
  createdByOperatorKind?: string;
  inputArtifactIds: string[];
  createdAt: string;
  metadata?: Record<string, unknown>;
};

export type Artifact<T = unknown> = {
  id: string;
  type: string;
  value: T;
  provenance: Provenance;
  visibility: ArtifactVisibility;
  leakage: ArtifactLeakage;
  contentType?: string;
};

export type OperatorSpec = {
  id: string;
  kind: string;
  inputTypes: string[];
  outputTypes: string[];
  sideEffects: OperatorSideEffects;
  allowedInputLeakage?: ArtifactLeakage[];
  retry?: RetryPolicy;
  expectedCost?: CostEstimate;
  expectedLatencyMs?: number;
};

export type RetryPolicy = {
  maxAttempts: number;
  retryableErrors?: string[];
};

export type CreateArtifactInput<T = unknown> = {
  id?: string;
  type: string;
  value: T;
  visibility?: ArtifactVisibility;
  leakage?: ArtifactLeakage;
  contentType?: string;
  provenance?: Partial<Provenance>;
};

export type OperatorRunContext = {
  runId: string;
  graphId: string;
  operator: OperatorSpec;
  budget: BudgetPolicy;
  signal?: AbortSignal;
  getArtifact(id: string): Artifact | undefined;
  createArtifact<T = unknown>(input: CreateArtifactInput<T>): Artifact<T>;
  consumeBudget(usage: BudgetUsage): void;
  recordObservation(input: RecordObservationInput): Observation;
  recordSignal(input: RecordSignalInput): Signal;
  recordTrace(input: TraceEventInput): TraceEvent;
};

export type Operator<I extends readonly Artifact[] = readonly Artifact[], O extends readonly Artifact[] = readonly Artifact[]> = {
  spec: OperatorSpec;
  run(inputs: I, ctx: OperatorRunContext): Promise<O> | O;
};

export type ArtifactInputRef =
  | { artifactId: string }
  | { nodeId: string; type?: string };

export type OperatorGraphNode = {
  id: string;
  operator: Operator;
  inputs?: ArtifactInputRef[];
  dependsOn?: string[];
};

export type OperatorGraph = {
  id: string;
  nodes: OperatorGraphNode[];
  inputArtifactIds?: string[];
  outputArtifactIds?: string[];
  metadata?: Record<string, unknown>;
};

export type BudgetPolicy = {
  id?: string;
  maxOperatorRuns?: number;
  maxArtifacts?: number;
  maxCandidates?: number;
  maxCostUsd?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxLatencyMs?: number;
  maxToolCalls?: number;
  allowedSideEffects?: OperatorSideEffects[];
  maxWorkspaceWriters?: number;
  allowPrivateRuntimeInputs?: boolean;
};

export type BudgetLedger = {
  operatorRuns: number;
  artifacts: number;
  candidates: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  workspaceWriters: number;
  startedAt: string;
  elapsedMs: number;
};

export type TraceEventType =
  | "runtime.started"
  | "runtime.finished"
  | "scheduler.decision"
  | "operator.started"
  | "operator.finished"
  | "operator.retry"
  | "artifact.created"
  | "observation.recorded"
  | "signal.recorded"
  | "budget.consumed"
  | "budget.exceeded";

export type TraceEventInput = {
  type: TraceEventType;
  nodeId?: string;
  operatorId?: string;
  inputArtifactIds?: string[];
  outputArtifactIds?: string[];
  payload?: Record<string, unknown>;
};

export type TraceEvent = TraceEventInput & {
  id: string;
  runId: string;
  graphId: string;
  timestamp: string;
};

export type RuntimeState = {
  artifactIds: string[];
  nodeOutputs: Record<string, string[]>;
  observationIds: string[];
  signalIds: string[];
  budget: BudgetLedger;
};

export type OutcomeRecord = {
  id: string;
  runId: string;
  graphId: string;
  schedulerId: string;
  schedulerFamily: string;
  status: RuntimeStatus;
  taskArtifactIds: string[];
  finalArtifactIds: string[];
  observationIds: string[];
  signalIds: string[];
  privateObservationIds: string[];
  privateSignalIds: string[];
  traceEventIds: string[];
  budget: BudgetLedger;
  startedAt: string;
  finishedAt: string;
  error?: string;
  metadata?: Record<string, unknown>;
};

export type SchedulerRunResult = {
  finalArtifactIds?: string[];
};

export type SchedulerExecutionContext = {
  runId: string;
  graphId: string;
  budget: BudgetPolicy;
  state(): RuntimeState;
  nodeOutputIds(nodeId: string): readonly string[];
  observationIds(): readonly string[];
  signalIds(): readonly string[];
  resolveInputs(node: OperatorGraphNode): readonly Artifact[];
  runNode(node: OperatorGraphNode): Promise<readonly Artifact[]>;
  recordTrace(input: TraceEventInput): TraceEvent;
};

export type Scheduler = {
  id: string;
  family: string;
  schedule(graph: OperatorGraph, ctx: SchedulerExecutionContext): Promise<SchedulerRunResult> | SchedulerRunResult;
};

export type RuntimeExecutionResult = {
  runId: string;
  graph: OperatorGraph;
  scheduler: Scheduler;
  artifacts: readonly Artifact[];
  observations: readonly Observation[];
  signals: readonly Signal[];
  finalArtifacts: readonly Artifact[];
  trace: readonly TraceEvent[];
  outcome: OutcomeRecord;
};

export type RuntimeReplayRecord = {
  schema: "fusion-runtime-replay.v1";
  runId: string;
  graph: OperatorGraph;
  scheduler: { id: string; family: string };
  artifacts: readonly Artifact[];
  observations: readonly Observation[];
  signals: readonly Signal[];
  trace: readonly TraceEvent[];
  outcome: OutcomeRecord;
};

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export class OperatorGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorGraphError";
  }
}

export class RuntimeCancelledError extends Error {
  constructor(message = "runtime cancelled") {
    super(message);
    this.name = "RuntimeCancelledError";
  }
}

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

let defaultArtifactIdCounter = 0;

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

export function createArtifact<T = unknown>(input: CreateArtifactInput<T>): Artifact<T> {
  const createdAt = input.provenance?.createdAt ?? new Date().toISOString();
  const provenance: Provenance = {
    inputArtifactIds: [...(input.provenance?.inputArtifactIds ?? [])],
    createdAt,
    ...(input.provenance?.runId !== undefined ? { runId: input.provenance.runId } : {}),
    ...(input.provenance?.graphId !== undefined ? { graphId: input.provenance.graphId } : {}),
    ...(input.provenance?.createdByOperatorId !== undefined
      ? { createdByOperatorId: input.provenance.createdByOperatorId }
      : {}),
    ...(input.provenance?.createdByOperatorKind !== undefined
      ? { createdByOperatorKind: input.provenance.createdByOperatorKind }
      : {}),
    ...(input.provenance?.metadata !== undefined ? { metadata: input.provenance.metadata } : {})
  };
  const artifact: Artifact<T> = {
    id: input.id ?? `artifact_${++defaultArtifactIdCounter}`,
    type: input.type,
    value: deepFreeze(input.value),
    provenance,
    visibility: input.visibility ?? "runtime",
    leakage: input.leakage ?? "none",
    ...(input.contentType !== undefined ? { contentType: input.contentType } : {})
  };
  return deepFreeze(artifact);
}

function cloneBudgetLedger(ledger: BudgetLedger): BudgetLedger {
  return { ...ledger };
}

function costOf(spec: OperatorSpec): CostEstimate {
  return spec.expectedCost ?? {};
}

function operatorInputTypesSatisfied(spec: OperatorSpec, inputs: readonly Artifact[]): boolean {
  for (const type of spec.inputTypes) {
    if (!inputs.some((artifact) => artifact.type === type)) return false;
  }
  return true;
}

function inputNodeIds(node: OperatorGraphNode): string[] {
  return (node.inputs ?? []).flatMap((input) => ("nodeId" in input ? [input.nodeId] : []));
}

function terminalNodeIds(graph: OperatorGraph): string[] {
  const dependedOn = new Set<string>();
  for (const node of graph.nodes) {
    for (const dependency of node.dependsOn ?? []) dependedOn.add(dependency);
    for (const dependency of inputNodeIds(node)) dependedOn.add(dependency);
  }
  return graph.nodes.map((node) => node.id).filter((id) => !dependedOn.has(id));
}

function validateGraph(graph: OperatorGraph): void {
  if (graph.id.length === 0) throw new OperatorGraphError("operator graph requires an id");
  if (graph.nodes.length === 0) throw new OperatorGraphError("operator graph requires at least one node");
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (ids.has(node.id)) throw new OperatorGraphError(`duplicate operator graph node id: ${node.id}`);
    ids.add(node.id);
    if (node.operator.spec.id.length === 0) {
      throw new OperatorGraphError(`operator graph node ${node.id} has an operator without an id`);
    }
  }
  for (const node of graph.nodes) {
    for (const dependency of [...(node.dependsOn ?? []), ...inputNodeIds(node)]) {
      if (!ids.has(dependency)) {
        throw new OperatorGraphError(`operator graph node ${node.id} depends on missing node ${dependency}`);
      }
    }
  }
}

function budgetMessage(limit: string, policy: BudgetPolicy): string {
  return `budget ${policy.id ?? "default"} exceeded: ${limit}`;
}

function isPrivateLeakage(leakage: ArtifactLeakage): boolean {
  switch (leakage) {
    case "private":
    case "contaminated":
      return true;
    case "none":
    case "public":
      return false;
    default: {
      const exhausted: never = leakage;
      throw new Error(`unsupported leakage class: ${String(exhausted)}`);
    }
  }
}

function schedulerVisibleArtifact(artifact: Artifact): boolean {
  return artifact.visibility !== "private_eval" && !isPrivateLeakage(artifact.leakage);
}

function schedulerVisibleObservation(observation: Observation): boolean {
  return observation.visibility !== "private_eval" && !isPrivateLeakage(observation.leakage);
}

function schedulerVisibleSignal(signal: Signal): boolean {
  return !isPrivateLeakage(signal.leakageRisk);
}

function usageWithDefaults(usage: BudgetUsage): Required<CostEstimate> {
  return {
    usd: usage.usd ?? 0,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    candidates: usage.candidates ?? 0,
    toolCalls: usage.toolCalls ?? 0
  };
}

function isRetryable(error: unknown, retry: RetryPolicy): boolean {
  if (retry.retryableErrors === undefined || retry.retryableErrors.length === 0) return true;
  const message = error instanceof Error ? error.message : String(error);
  return retry.retryableErrors.some((needle) => message.includes(needle));
}

export class FusionRuntime {
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  async run(input: {
    graph: OperatorGraph;
    scheduler: Scheduler;
    artifacts?: readonly Artifact[];
    budget?: BudgetPolicy;
    runId?: string;
    signal?: AbortSignal;
    metadata?: Record<string, unknown>;
  }): Promise<RuntimeExecutionResult> {
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
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
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
      ledger.costUsd += actual.usd;
      ledger.inputTokens += actual.inputTokens;
      ledger.outputTokens += actual.outputTokens;
      ledger.candidates += actual.candidates;
      ledger.toolCalls += actual.toolCalls;
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
      ensureUsageBudget(expected, spec.id);
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
        if (budget.allowPrivateRuntimeInputs === true) return;
        const allowedLeakage = node.operator.spec.allowedInputLeakage ?? ["none", "public"];
        if (
          artifact.visibility === "private_eval" ||
          (!allowedLeakage.includes(artifact.leakage) && isPrivateLeakage(artifact.leakage))
        ) {
          throw new OperatorGraphError(
            `node ${node.id} cannot consume private/contaminated artifact ${artifact.id} at runtime`
          );
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
      ledger.costUsd += expected.usd ?? 0;
      ledger.inputTokens += expected.inputTokens ?? 0;
      ledger.outputTokens += expected.outputTokens ?? 0;
      ledger.candidates += expected.candidates ?? 0;
      ledger.toolCalls += expected.toolCalls ?? 0;
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
        operator: node.operator.spec,
        budget,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
        getArtifact: (id) => store.artifacts.get(id),
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
          for (const observationId of observationIds) {
            if (store.observations.get(observationId) === undefined) {
              throw new OperatorGraphError(`signal ${signalInput.id ?? "(new)"} references missing observation ${observationId}`);
            }
          }
          const signal: Signal = deepFreeze({
            id: signalInput.id ?? `${node.operator.spec.id}.signal.${++counters.signal}`,
            targetArtifactId: signalInput.targetArtifactId,
            dimension: signalInput.dimension,
            score: signalInput.score,
            confidence: signalInput.confidence,
            calibration: signalInput.calibration,
            leakageRisk: signalInput.leakageRisk ?? "public",
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
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {})
      });
      Object.freeze(failedOutcome);
      throw error;
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
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {})
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

  #outcome(input: {
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
  }): OutcomeRecord {
    const finishedAt = new Date(this.#now()).toISOString();
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
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {})
    };
  }
}

function isArtifact(value: Artifact | undefined): value is Artifact {
  return value !== undefined;
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

export class DirectFastPathScheduler implements Scheduler {
  readonly id: string;
  readonly family = "direct-fast-path";

  constructor(id = "direct-fast-path") {
    this.id = id;
  }

  async schedule(graph: OperatorGraph, ctx: SchedulerExecutionContext): Promise<SchedulerRunResult> {
    if (graph.nodes.length !== 1) {
      throw new OperatorGraphError("DirectFastPathScheduler requires exactly one operator node");
    }
    const node = graph.nodes[0];
    if (node === undefined) throw new OperatorGraphError("DirectFastPathScheduler requires a node");
    ctx.recordTrace({
      type: "scheduler.decision",
      nodeId: node.id,
      operatorId: node.operator.spec.id,
      payload: { reason: "degree-1 direct fast path" }
    });
    const outputs = await ctx.runNode(node);
    return { finalArtifactIds: outputs.map((artifact) => artifact.id) };
  }
}

export class StaticDAGScheduler implements Scheduler {
  readonly id: string;
  readonly family = "static-dag";
  readonly #maxConcurrency: number;

  constructor(input: string | { id?: string; maxConcurrency?: number } = "static-dag") {
    if (typeof input === "string") {
      this.id = input;
      this.#maxConcurrency = 1;
    } else {
      this.id = input.id ?? "static-dag";
      this.#maxConcurrency = Math.max(1, input.maxConcurrency ?? 1);
    }
  }

  async schedule(graph: OperatorGraph, ctx: SchedulerExecutionContext): Promise<SchedulerRunResult> {
    const remaining = new Map(graph.nodes.map((node) => [node.id, node]));
    const completed = new Set<string>();
    while (remaining.size > 0) {
      const ready: Array<[string, OperatorGraphNode]> = [];
      for (const [nodeId, node] of remaining.entries()) {
        const dependencies = [...(node.dependsOn ?? []), ...inputNodeIds(node)];
        if (dependencies.some((dependency) => !completed.has(dependency))) continue;
        ready.push([nodeId, node]);
      }
      if (ready.length === 0) {
        throw new OperatorGraphError(
          `operator graph ${graph.id} has a cycle or unsatisfied dependencies: ${[...remaining.keys()].join(", ")}`
        );
      }
      for (let index = 0; index < ready.length; index += this.#maxConcurrency) {
        const batch = ready.slice(index, index + this.#maxConcurrency);
        await Promise.all(
          batch.map(async ([nodeId, node]) => {
            const dependencies = [...(node.dependsOn ?? []), ...inputNodeIds(node)];
            ctx.recordTrace({
              type: "scheduler.decision",
              nodeId,
              operatorId: node.operator.spec.id,
              payload: { ready_dependencies: dependencies, concurrency: this.#maxConcurrency }
            });
            await ctx.runNode(node);
          })
        );
        for (const [nodeId] of batch) {
          completed.add(nodeId);
          remaining.delete(nodeId);
        }
      }
    }
    const finalArtifactIds =
      graph.outputArtifactIds ?? terminalNodeIds(graph).flatMap((nodeId) => ctx.nodeOutputIds(nodeId));
    return { finalArtifactIds };
  }
}
