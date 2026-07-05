import { inputNodeIds, terminalNodeIds } from "./graph-utils.js";
import type { OperatorGraph, OperatorGraphNode, Scheduler, SchedulerExecutionContext, SchedulerRunResult } from "./types.js";
import { OperatorGraphError } from "./types.js";

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
