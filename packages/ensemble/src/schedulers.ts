import {
  OperatorGraphError,
  StaticDAGScheduler
} from "./runtime.js";
import type {
  OperatorGraph,
  OperatorGraphNode,
  Scheduler,
  SchedulerExecutionContext,
  SchedulerRunResult
} from "./runtime.js";

type RunGraphOptions = {
  maxConcurrency?: number;
  chooseReady?: (ready: readonly OperatorGraphNode[], ctx: SchedulerExecutionContext) => OperatorGraphNode | undefined;
};

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

function dependenciesFor(node: OperatorGraphNode): string[] {
  return [...(node.dependsOn ?? []), ...inputNodeIds(node)];
}

function ensureKinds(graph: OperatorGraph, family: string, kinds: readonly string[]): void {
  for (const kind of kinds) {
    if (!graph.nodes.some((node) => node.operator.spec.kind === kind)) {
      throw new OperatorGraphError(`${family} requires at least one ${kind} operator`);
    }
  }
}

async function runLayer(
  layer: readonly OperatorGraphNode[],
  ctx: SchedulerExecutionContext,
  maxConcurrency: number,
  family: string
): Promise<void> {
  for (let index = 0; index < layer.length; index += maxConcurrency) {
    const batch = layer.slice(index, index + maxConcurrency);
    await Promise.all(
      batch.map(async (node) => {
        ctx.recordTrace({
          type: "scheduler.decision",
          nodeId: node.id,
          operatorId: node.operator.spec.id,
          payload: { family, layer_concurrency: maxConcurrency }
        });
        await ctx.runNode(node);
      })
    );
  }
}

async function runGraph(
  graph: OperatorGraph,
  ctx: SchedulerExecutionContext,
  family: string,
  options: RunGraphOptions = {}
): Promise<SchedulerRunResult> {
  const remaining = new Map(graph.nodes.map((node) => [node.id, node]));
  const completed = new Set<string>();
  const maxConcurrency = Math.max(1, options.maxConcurrency ?? 1);
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((node) =>
      dependenciesFor(node).every((dependency) => completed.has(dependency))
    );
    if (ready.length === 0) {
      throw new OperatorGraphError(
        `${family} graph ${graph.id} has a cycle or unsatisfied dependencies: ${[...remaining.keys()].join(", ")}`
      );
    }
    let runnable: readonly OperatorGraphNode[];
    if (options.chooseReady !== undefined) {
      const chosen = options.chooseReady(ready, ctx);
      if (chosen === undefined || !ready.some((node) => node.id === chosen.id)) {
        throw new OperatorGraphError(`${family} policy must choose one of the ready nodes`);
      }
      runnable = [chosen];
    } else {
      runnable = ready;
    }
    await runLayer(runnable, ctx, maxConcurrency, family);
    for (const node of runnable) {
      completed.add(node.id);
      remaining.delete(node.id);
    }
  }
  const finalArtifactIds =
    graph.outputArtifactIds ?? terminalNodeIds(graph).flatMap((nodeId) => ctx.nodeOutputIds(nodeId));
  return { finalArtifactIds };
}

function inferLayers(graph: OperatorGraph): OperatorGraphNode[][] {
  const remaining = new Map(graph.nodes.map((node) => [node.id, node]));
  const completed = new Set<string>();
  const layers: OperatorGraphNode[][] = [];
  while (remaining.size > 0) {
    const layer = [...remaining.values()].filter((node) =>
      dependenciesFor(node).every((dependency) => completed.has(dependency))
    );
    if (layer.length === 0) {
      throw new OperatorGraphError(
        `fixed-layer-moa graph ${graph.id} has a cycle or unsatisfied dependencies: ${[...remaining.keys()].join(", ")}`
      );
    }
    layers.push(layer);
    for (const node of layer) {
      completed.add(node.id);
      remaining.delete(node.id);
    }
  }
  return layers;
}

function countKind(graph: OperatorGraph, kind: string): number {
  return graph.nodes.filter((node) => node.operator.spec.kind === kind).length;
}

export class FixedLayerMoAScheduler implements Scheduler {
  readonly id: string;
  readonly family = "fixed-layer-moa";
  readonly #layers: string[][] | undefined;
  readonly #maxConcurrency: number;

  constructor(options: { id?: string; layers?: string[][]; maxConcurrency?: number } = {}) {
    this.id = options.id ?? "fixed-layer-moa";
    this.#layers = options.layers;
    this.#maxConcurrency = Math.max(1, options.maxConcurrency ?? Number.MAX_SAFE_INTEGER);
  }

  async schedule(graph: OperatorGraph, ctx: SchedulerExecutionContext): Promise<SchedulerRunResult> {
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    const layers =
      this.#layers?.map((layer) =>
        layer.map((nodeId) => {
          const node = nodesById.get(nodeId);
          if (node === undefined) throw new OperatorGraphError(`fixed layer references missing node ${nodeId}`);
          return node;
        })
      ) ?? inferLayers(graph);
    for (const layer of layers) {
      await runLayer(layer, ctx, this.#maxConcurrency, this.family);
    }
    const finalArtifactIds =
      graph.outputArtifactIds ?? terminalNodeIds(graph).flatMap((nodeId) => ctx.nodeOutputIds(nodeId));
    return { finalArtifactIds };
  }
}

export class BestOfNScheduler implements Scheduler {
  readonly id: string;
  readonly family = "best-of-n";
  readonly #maxCandidates: number;

  constructor(options: { id?: string; maxCandidates: number }) {
    if (!Number.isInteger(options.maxCandidates) || options.maxCandidates < 1) {
      throw new OperatorGraphError("best-of-n maxCandidates must be a positive integer");
    }
    this.id = options.id ?? "best-of-n";
    this.#maxCandidates = options.maxCandidates;
  }

  schedule(graph: OperatorGraph, ctx: SchedulerExecutionContext): Promise<SchedulerRunResult> {
    const generatorCount = countKind(graph, "model.generate") + countKind(graph, "panel.generate");
    if (generatorCount > this.#maxCandidates) {
      throw new OperatorGraphError(
        `best-of-n graph declares ${generatorCount} generator operator(s), above maxCandidates ${this.#maxCandidates}`
      );
    }
    return runGraph(graph, ctx, this.family);
  }
}

export class RankFuseScheduler implements Scheduler {
  readonly id: string;
  readonly family = "rank-fuse";

  constructor(id = "rank-fuse") {
    this.id = id;
  }

  schedule(graph: OperatorGraph, ctx: SchedulerExecutionContext): Promise<SchedulerRunResult> {
    ensureKinds(graph, this.family, ["rank", "fuse"]);
    return runGraph(graph, ctx, this.family);
  }
}

export class ExecutionSelectRepairScheduler implements Scheduler {
  readonly id: string;
  readonly family = "execution-select-repair";
  readonly #maxRepairRounds: number;

  constructor(options: { id?: string; maxRepairRounds?: number } = {}) {
    this.id = options.id ?? "execution-select-repair";
    this.#maxRepairRounds = options.maxRepairRounds ?? 1;
  }

  schedule(graph: OperatorGraph, ctx: SchedulerExecutionContext): Promise<SchedulerRunResult> {
    ensureKinds(graph, this.family, ["evidence", "select"]);
    const repairCount = countKind(graph, "repair");
    if (repairCount > this.#maxRepairRounds) {
      throw new OperatorGraphError(
        `execution-select-repair graph declares ${repairCount} repair operator(s), above maxRepairRounds ${this.#maxRepairRounds}`
      );
    }
    return runGraph(graph, ctx, this.family);
  }
}

export class AdaptiveRouterScheduler implements Scheduler {
  readonly id: string;
  readonly family = "adaptive-router";

  constructor(id = "adaptive-router") {
    this.id = id;
  }

  schedule(graph: OperatorGraph, ctx: SchedulerExecutionContext): Promise<SchedulerRunResult> {
    ensureKinds(graph, this.family, ["route"]);
    return runGraph(graph, ctx, this.family);
  }
}

export class TreeSearchScheduler implements Scheduler {
  readonly id: string;
  readonly family = "tree-search";
  readonly #maxExpansions: number;

  constructor(options: { id?: string; maxExpansions?: number } = {}) {
    this.id = options.id ?? "tree-search";
    this.#maxExpansions = options.maxExpansions ?? Number.MAX_SAFE_INTEGER;
  }

  schedule(graph: OperatorGraph, ctx: SchedulerExecutionContext): Promise<SchedulerRunResult> {
    ensureKinds(graph, this.family, ["tree.expand", "tree.score"]);
    const expansionCount = countKind(graph, "tree.expand");
    if (expansionCount > this.#maxExpansions) {
      throw new OperatorGraphError(
        `tree-search graph declares ${expansionCount} expansion operator(s), above maxExpansions ${this.#maxExpansions}`
      );
    }
    return runGraph(graph, ctx, this.family);
  }
}

export class AgenticDelegationScheduler implements Scheduler {
  readonly id: string;
  readonly family = "agentic-delegation";

  constructor(id = "agentic-delegation") {
    this.id = id;
  }

  schedule(graph: OperatorGraph, ctx: SchedulerExecutionContext): Promise<SchedulerRunResult> {
    ensureKinds(graph, this.family, ["delegate"]);
    return runGraph(graph, ctx, this.family, { maxConcurrency: 1 });
  }
}

export type LearnedWorkflowPolicy = {
  chooseReadyNode(
    input: {
      graph: OperatorGraph;
      ready: readonly OperatorGraphNode[];
      state: ReturnType<SchedulerExecutionContext["state"]>;
    }
  ): string | undefined;
};

export class LearnedWorkflowScheduler implements Scheduler {
  readonly id: string;
  readonly family = "learned-workflow";
  readonly #policy: LearnedWorkflowPolicy;

  constructor(options: { id?: string; policy: LearnedWorkflowPolicy }) {
    this.id = options.id ?? "learned-workflow";
    this.#policy = options.policy;
  }

  schedule(graph: OperatorGraph, ctx: SchedulerExecutionContext): Promise<SchedulerRunResult> {
    return runGraph(graph, ctx, this.family, {
      chooseReady: (ready) => {
        const selectedId = this.#policy.chooseReadyNode({ graph, ready, state: ctx.state() });
        if (selectedId === undefined) {
          throw new OperatorGraphError("learned workflow policy did not choose a ready node");
        }
        const selected = ready.find((node) => node.id === selectedId);
        if (selected === undefined) {
          throw new OperatorGraphError(`learned workflow policy chose non-ready node ${selectedId}`);
        }
        return selected;
      }
    });
  }
}

export class OfflineArchitectureSearchScheduler implements Scheduler {
  readonly id: string;
  readonly family = "offline-architecture-search";

  constructor(id = "offline-architecture-search") {
    this.id = id;
  }

  schedule(graph: OperatorGraph, ctx: SchedulerExecutionContext): Promise<SchedulerRunResult> {
    ensureKinds(graph, this.family, ["architecture.evaluate"]);
    return new StaticDAGScheduler({ id: this.id }).schedule(graph, ctx);
  }
}
