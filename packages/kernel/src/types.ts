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
  /** Backward-compatible alias for requiredInputTypes. Prefer requiredInputTypes in new code. */
  inputTypes?: string[];
  requiredInputTypes?: string[];
  optionalInputTypes?: string[];
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
  nodeId: string;
  operator: OperatorSpec;
  budget: BudgetPolicy;
  signal?: AbortSignal;
  getArtifact(id: string): Artifact | undefined;
  getObservation(id: string): Observation | undefined;
  getSignal(id: string): Signal | undefined;
  visibleObservations(filter?: ObservationFilter): readonly Observation[];
  visibleSignals(filter?: SignalFilter): readonly Signal[];
  createArtifact<T = unknown>(input: CreateArtifactInput<T>): Artifact<T>;
  consumeBudget(usage: BudgetUsage): void;
  recordObservation(input: RecordObservationInput): Observation;
  recordSignal(input: RecordSignalInput): Signal;
  recordTrace(input: TraceEventInput): TraceEvent;
};

export type ObservationFilter = {
  targetArtifactId?: string;
  sourceId?: string;
  type?: string;
};

export type SignalFilter = {
  targetArtifactId?: string;
  dimension?: SignalDimension;
};

export type Operator<I extends readonly Artifact[] = readonly Artifact[], O extends readonly Artifact[] = readonly Artifact[]> = {
  spec: OperatorSpec;
  run(inputs: I, ctx: OperatorRunContext): Promise<O> | O;
};

export type RuntimeEvent =
  | TraceEvent
  | { type: "output.delta"; artifactId?: string; content: string }
  | { type: "tool_call.delta"; callId: string; delta: unknown }
  | { type: "sse.chunk"; data: string }
  | { type: "keepalive" }
  | { type: "final"; result: RuntimeExecutionResult }
  | { type: "error"; error: RuntimeExecutionError };

export type StreamingOperator<
  I extends readonly Artifact[] = readonly Artifact[],
  O extends readonly Artifact[] = readonly Artifact[]
> = Operator<I, O> & {
  stream?(inputs: I, ctx: OperatorRunContext): AsyncIterable<RuntimeEvent>;
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
  expectedCostPolicy?: "reserve" | "advisory";
};

export type BudgetLedger = {
  operatorRuns: number;
  artifacts: number;
  candidates: number;
  costUsd: number;
  reservedCostUsd: number;
  actualCostUsd: number;
  inputTokens: number;
  reservedInputTokens: number;
  actualInputTokens: number;
  outputTokens: number;
  reservedOutputTokens: number;
  actualOutputTokens: number;
  toolCalls: number;
  reservedToolCalls: number;
  actualToolCalls: number;
  reservedCandidates: number;
  actualCandidates: number;
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
  success?: {
    metric: string;
    value: number | boolean;
    leakage: ArtifactLeakage;
  };
  taskFeatures?: Record<string, unknown>;
  operatorSummaries?: Array<{
    nodeId: string;
    operatorId: string;
    kind: string;
    inputArtifactIds: string[];
    outputArtifactIds: string[];
  }>;
  decisionTrace?: string[];
  availableSignalIds?: string[];
  selectedArtifactIds?: string[];
  counterfactualArtifactIds?: string[];
  evaluationSplit?: string;
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
  getObservation(id: string): Observation | undefined;
  getSignal(id: string): Signal | undefined;
  visibleObservations(filter?: ObservationFilter): readonly Observation[];
  visibleSignals(filter?: SignalFilter): readonly Signal[];
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

export type KernelTurnState = {
  turn: number;
  candidateArtifactIds: string[];
  replayRecordId?: string;
  status: "pending" | "succeeded" | "failed";
};

export type KernelSessionState<Cost = unknown, Metadata = Record<string, unknown>> = {
  sessionId: string;
  traceId: string;
  sessionSpanId: string;
  turns: Record<number, KernelTurnState>;
  cost: Cost;
  metadata: Metadata;
};

export type KernelStateStore<Cost = unknown, Metadata = Record<string, unknown>> = {
  load(sessionId: string): KernelSessionState<Cost, Metadata> | undefined;
  save(state: KernelSessionState<Cost, Metadata>): void;
  update(
    sessionId: string,
    updater: (state: KernelSessionState<Cost, Metadata> | undefined) => KernelSessionState<Cost, Metadata>
  ): KernelSessionState<Cost, Metadata>;
};

export class InMemoryKernelStateStore<Cost = unknown, Metadata = Record<string, unknown>>
  implements KernelStateStore<Cost, Metadata>
{
  readonly #sessions = new Map<string, KernelSessionState<Cost, Metadata>>();

  load(sessionId: string): KernelSessionState<Cost, Metadata> | undefined {
    return this.#sessions.get(sessionId);
  }

  save(state: KernelSessionState<Cost, Metadata>): void {
    this.#sessions.set(state.sessionId, state);
  }

  update(
    sessionId: string,
    updater: (state: KernelSessionState<Cost, Metadata> | undefined) => KernelSessionState<Cost, Metadata>
  ): KernelSessionState<Cost, Metadata> {
    const next = updater(this.#sessions.get(sessionId));
    if (next.sessionId !== sessionId) {
      throw new Error(`kernel session update for ${sessionId} returned mismatched session ${next.sessionId}`);
    }
    this.save(next);
    return next;
  }
}

export class RuntimeExecutionError extends Error {
  readonly outcome: OutcomeRecord;
  readonly trace: readonly TraceEvent[];
  readonly artifacts: readonly Artifact[];
  readonly observations: readonly Observation[];
  readonly signals: readonly Signal[];

  constructor(input: {
    message: string;
    outcome: OutcomeRecord;
    trace: readonly TraceEvent[];
    artifacts: readonly Artifact[];
    observations: readonly Observation[];
    signals: readonly Signal[];
    cause?: unknown;
  }) {
    super(input.message);
    this.name = "RuntimeExecutionError";
    this.outcome = input.outcome;
    this.trace = input.trace;
    this.artifacts = input.artifacts;
    this.observations = input.observations;
    this.signals = input.signals;
    if (input.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        value: input.cause,
        configurable: true,
        writable: true
      });
    }
  }
}

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
