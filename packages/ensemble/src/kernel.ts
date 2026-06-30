import { artifactRef, nodeRef } from "./graph-utils.js";
import { validateSchedulerGraph } from "./graph-validation.js";
import { FusionRuntime } from "./runtime.js";
import type {
  Artifact,
  ArtifactInputRef,
  BudgetPolicy,
  Operator,
  OperatorGraph,
  OperatorGraphNode,
  RuntimeExecutionResult,
  Scheduler
} from "./runtime.js";

export type GraphNodeInput = {
  inputs?: ArtifactInputRef[];
  dependsOn?: string[];
};

export type KernelWorkflow = {
  graph: OperatorGraph;
  scheduler: Scheduler;
  artifacts: readonly Artifact[];
  budget?: BudgetPolicy;
  run(input?: { runtime?: FusionRuntime; runId?: string; signal?: AbortSignal }): Promise<RuntimeExecutionResult>;
};

export class GraphBuilder {
  readonly #id: string;
  readonly #nodes: OperatorGraphNode[] = [];
  readonly #artifacts: Artifact[] = [];
  #scheduler: Scheduler | undefined;
  #budget: BudgetPolicy | undefined;
  #metadata: Record<string, unknown> | undefined;
  #outputArtifactIds: string[] | undefined;

  constructor(id: string) {
    if (id.length === 0) throw new Error("graph builder requires an id");
    this.#id = id;
  }

  task(artifact: Artifact): this {
    this.#artifacts.push(artifact);
    return this;
  }

  artifact(artifact: Artifact): this {
    this.#artifacts.push(artifact);
    return this;
  }

  node(id: string, operator: Operator, input: GraphNodeInput = {}): this {
    if (this.#nodes.some((node) => node.id === id)) throw new Error(`duplicate node id ${id}`);
    this.#nodes.push({
      id,
      operator,
      ...(input.inputs !== undefined ? { inputs: input.inputs } : {}),
      ...(input.dependsOn !== undefined ? { dependsOn: input.dependsOn } : {})
    });
    return this;
  }

  pipe(id: string, operator: Operator, from: string | readonly string[], extraInputs: ArtifactInputRef[] = []): this {
    const sources = Array.isArray(from) ? from : [from];
    return this.node(id, operator, {
      inputs: [...extraInputs, ...sources.map((source) => nodeRef(source))],
      dependsOn: [...sources]
    });
  }

  scheduler(scheduler: Scheduler): this {
    this.#scheduler = scheduler;
    return this;
  }

  budget(budget: BudgetPolicy): this {
    this.#budget = budget;
    return this;
  }

  metadata(metadata: Record<string, unknown>): this {
    this.#metadata = metadata;
    return this;
  }

  outputs(ids: string[]): this {
    this.#outputArtifactIds = ids;
    return this;
  }

  compile(): KernelWorkflow {
    const scheduler = this.#scheduler;
    if (scheduler === undefined) throw new Error(`graph ${this.#id} requires a scheduler`);
    const graph: OperatorGraph = {
      id: this.#id,
      nodes: [...this.#nodes],
      inputArtifactIds: this.#artifacts.map((artifact) => artifact.id),
      ...(this.#outputArtifactIds !== undefined ? { outputArtifactIds: [...this.#outputArtifactIds] } : {}),
      ...(this.#metadata !== undefined ? { metadata: this.#metadata } : {})
    };
    const issues = validateSchedulerGraph(graph, scheduler).filter((issue) => issue.severity === "error");
    if (issues.length > 0) throw new Error(issues.map((issue) => issue.message).join("; "));
    const artifacts = [...this.#artifacts];
    const budget = this.#budget;
    return {
      graph,
      scheduler,
      artifacts,
      ...(budget !== undefined ? { budget } : {}),
      run: async (input = {}) =>
        (input.runtime ?? new FusionRuntime()).run({
          graph,
          scheduler,
          artifacts,
          ...(budget !== undefined ? { budget } : {}),
          ...(input.runId !== undefined ? { runId: input.runId } : {}),
          ...(input.signal !== undefined ? { signal: input.signal } : {})
        })
    };
  }
}

export function graph(id: string): GraphBuilder {
  return new GraphBuilder(id);
}

export const refs = {
  artifact: artifactRef,
  node: nodeRef
};

export type WorkflowFactory<I = any> = (input: I) => KernelWorkflow;

const workflowRegistry = new Map<string, WorkflowFactory>();

export function registerWorkflow<I>(id: string, factory: WorkflowFactory<I>): void {
  if (id.length === 0) throw new Error("workflow id must be non-empty");
  if (workflowRegistry.has(id)) throw new Error(`workflow ${id} is already registered`);
  workflowRegistry.set(id, factory as WorkflowFactory);
}

export function getWorkflow<I>(id: string): WorkflowFactory<I> | undefined {
  return workflowRegistry.get(id) as WorkflowFactory<I> | undefined;
}

export function listWorkflows(): string[] {
  return [...workflowRegistry.keys()].sort();
}

export async function runWorkflow<I>(
  id: string,
  input: I,
  options: { runtime?: FusionRuntime; runId?: string; signal?: AbortSignal } = {}
): Promise<RuntimeExecutionResult> {
  const factory = getWorkflow<I>(id);
  if (factory === undefined) throw new Error(`workflow ${id} is not registered`);
  return factory(input).run(options);
}
