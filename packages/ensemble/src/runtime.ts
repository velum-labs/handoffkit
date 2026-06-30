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
  expectedCost?: CostEstimate;
  expectedLatencyMs?: number;
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
  maxLatencyMs?: number;
  maxToolCalls?: number;
  allowedSideEffects?: OperatorSideEffects[];
  maxWorkspaceWriters?: number;
};

export type BudgetLedger = {
  operatorRuns: number;
  artifacts: number;
  candidates: number;
  costUsd: number;
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
  | "artifact.created"
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
  finalArtifacts: readonly Artifact[];
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

type RuntimeCounters = {
  artifact: number;
  trace: number;
};

type RuntimeStore = {
  artifacts: Map<string, Artifact>;
  nodeOutputs: Map<string, string[]>;
  trace: TraceEvent[];
};

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
    id: input.id ?? `artifact_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    type: input.type,
    value: input.value,
    provenance,
    visibility: input.visibility ?? "runtime",
    leakage: input.leakage ?? "none",
    ...(input.contentType !== undefined ? { contentType: input.contentType } : {})
  };
  return Object.freeze(artifact);
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
      toolCalls: 0,
      workspaceWriters: 0,
      startedAt,
      elapsedMs: 0
    };
    const counters: RuntimeCounters = { artifact: 0, trace: 0 };
    const store: RuntimeStore = {
      artifacts: new Map(),
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
      store.artifacts.set(artifact.id, Object.freeze(artifact));
    }
    recordTrace({
      type: "runtime.started",
      payload: { scheduler_id: input.scheduler.id, scheduler_family: input.scheduler.family }
    });

    const updateElapsed = (): void => {
      ledger.elapsedMs = Math.max(0, this.#now() - startedAtMs);
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
      if (budget.maxCostUsd !== undefined && ledger.costUsd + (expected.usd ?? 0) > budget.maxCostUsd) {
        recordTrace({ type: "budget.exceeded", operatorId: spec.id, payload: { limit: "maxCostUsd" } });
        throw new BudgetExceededError(
          budgetMessage(`cost ${ledger.costUsd + (expected.usd ?? 0)} > ${budget.maxCostUsd}`, budget)
        );
      }
      if (budget.maxCandidates !== undefined && ledger.candidates + (expected.candidates ?? 0) > budget.maxCandidates) {
        recordTrace({ type: "budget.exceeded", operatorId: spec.id, payload: { limit: "maxCandidates" } });
        throw new BudgetExceededError(
          budgetMessage(`candidates ${ledger.candidates + (expected.candidates ?? 0)} > ${budget.maxCandidates}`, budget)
        );
      }
      if (budget.maxToolCalls !== undefined && ledger.toolCalls + (expected.toolCalls ?? 0) > budget.maxToolCalls) {
        recordTrace({ type: "budget.exceeded", operatorId: spec.id, payload: { limit: "maxToolCalls" } });
        throw new BudgetExceededError(
          budgetMessage(`tool calls ${ledger.toolCalls + (expected.toolCalls ?? 0)} > ${budget.maxToolCalls}`, budget)
        );
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
      for (const ref of refs) {
        if ("artifactId" in ref) {
          const artifact = store.artifacts.get(ref.artifactId);
          if (artifact === undefined) {
            throw new OperatorGraphError(`node ${node.id} references missing artifact ${ref.artifactId}`);
          }
          resolved.push(artifact);
        } else {
          const outputIds = store.nodeOutputs.get(ref.nodeId);
          if (outputIds === undefined) {
            throw new OperatorGraphError(`node ${node.id} references unfinished node ${ref.nodeId}`);
          }
          for (const artifactId of outputIds) {
            const artifact = store.artifacts.get(artifactId);
            if (artifact !== undefined && (ref.type === undefined || artifact.type === ref.type)) {
              resolved.push(artifact);
            }
          }
        }
      }
      return Object.freeze(resolved);
    };
    const runNode = async (node: OperatorGraphNode): Promise<readonly Artifact[]> => {
      const inputs = resolveInputs(node);
      if (!operatorInputTypesSatisfied(node.operator.spec, inputs)) {
        throw new OperatorGraphError(
          `node ${node.id} operator ${node.operator.spec.id} missing required input artifact type`
        );
      }
      ensureBudget(node.operator.spec);
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
        recordTrace
      };
      const outputs = await node.operator.run(inputs, operatorContext);
      const outputIds: string[] = [];
      for (const artifact of outputs) {
        if (store.artifacts.has(artifact.id)) throw new OperatorGraphError(`duplicate artifact id: ${artifact.id}`);
        if (!node.operator.spec.outputTypes.includes(artifact.type)) {
          throw new OperatorGraphError(
            `operator ${node.operator.spec.id} emitted unsupported artifact type ${artifact.type}`
          );
        }
        store.artifacts.set(artifact.id, Object.freeze(artifact));
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
      const expected = costOf(node.operator.spec);
      ledger.operatorRuns += 1;
      ledger.artifacts = store.artifacts.size;
      ledger.candidates += expected.candidates ?? outputs.filter((artifact) => artifact.type === "candidate").length;
      ledger.costUsd += expected.usd ?? 0;
      ledger.toolCalls += expected.toolCalls ?? 0;
      if (node.operator.spec.sideEffects === "write_workspace") ledger.workspaceWriters += 1;
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
        artifactIds: [...store.artifacts.keys()],
        nodeOutputs: Object.fromEntries([...store.nodeOutputs.entries()].map(([key, value]) => [key, [...value]])),
        budget: cloneBudgetLedger(ledger)
      }),
      nodeOutputIds: (nodeId) => Object.freeze([...(store.nodeOutputs.get(nodeId) ?? [])]),
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
      status = "failed";
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

  constructor(id = "static-dag") {
    this.id = id;
  }

  async schedule(graph: OperatorGraph, ctx: SchedulerExecutionContext): Promise<SchedulerRunResult> {
    const remaining = new Map(graph.nodes.map((node) => [node.id, node]));
    const completed = new Set<string>();
    while (remaining.size > 0) {
      let progressed = false;
      for (const [nodeId, node] of [...remaining.entries()]) {
        const dependencies = [...(node.dependsOn ?? []), ...inputNodeIds(node)];
        if (dependencies.some((dependency) => !completed.has(dependency))) continue;
        ctx.recordTrace({
          type: "scheduler.decision",
          nodeId,
          operatorId: node.operator.spec.id,
          payload: { ready_dependencies: dependencies }
        });
        await ctx.runNode(node);
        completed.add(nodeId);
        remaining.delete(nodeId);
        progressed = true;
      }
      if (!progressed) {
        throw new OperatorGraphError(
          `operator graph ${graph.id} has a cycle or unsatisfied dependencies: ${[...remaining.keys()].join(", ")}`
        );
      }
    }
    const finalArtifactIds =
      graph.outputArtifactIds ?? terminalNodeIds(graph).flatMap((nodeId) => ctx.nodeOutputIds(nodeId));
    return { finalArtifactIds };
  }
}
