import { dependenciesFor, inputNodeIds, nodesById, topoLayers } from "./graph-utils.js";
import type { OperatorGraph, OperatorGraphNode, Scheduler } from "./runtime.js";

export type GraphValidationIssue = {
  severity: "error" | "warning";
  code: string;
  message: string;
  nodeId?: string;
};

export type GraphExplanation = {
  graphId: string;
  nodeCount: number;
  layers: string[][];
  terminalNodeIds: string[];
  issues: GraphValidationIssue[];
};

function requiredInputTypes(node: OperatorGraphNode): string[] {
  return node.operator.spec.requiredInputTypes ?? node.operator.spec.inputTypes ?? [];
}

function optionalInputTypes(node: OperatorGraphNode): string[] {
  return node.operator.spec.optionalInputTypes ?? [];
}

export function validateOperatorGraph(graph: OperatorGraph): GraphValidationIssue[] {
  const issues: GraphValidationIssue[] = [];
  if (graph.id.length === 0) {
    issues.push({ severity: "error", code: "graph.id.empty", message: "operator graph requires an id" });
  }
  if (graph.nodes.length === 0) {
    issues.push({ severity: "error", code: "graph.nodes.empty", message: "operator graph requires at least one node" });
  }
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (ids.has(node.id)) {
      issues.push({ severity: "error", code: "node.id.duplicate", message: `duplicate node id ${node.id}`, nodeId: node.id });
    }
    ids.add(node.id);
    if (node.operator.spec.id.length === 0) {
      issues.push({ severity: "error", code: "operator.id.empty", message: `node ${node.id} operator requires an id`, nodeId: node.id });
    }
    for (const type of requiredInputTypes(node)) {
      const hasPotentialInput = (node.inputs ?? []).some((input) => {
        if ("artifactId" in input) return graph.inputArtifactIds?.includes(input.artifactId) ?? false;
        const source = nodesById(graph).get(input.nodeId);
        return source?.operator.spec.outputTypes.includes(type) ?? false;
      });
      if (!hasPotentialInput) {
        issues.push({
          severity: "warning",
          code: "node.input.unwired",
          message: `node ${node.id} requires input type ${type} but graph topology has no obvious producer`,
          nodeId: node.id
        });
      }
    }
    for (const type of optionalInputTypes(node)) {
      if (!node.operator.spec.outputTypes.includes(type) && type.length === 0) {
        issues.push({
          severity: "warning",
          code: "node.optional-input.empty",
          message: `node ${node.id} declares an empty optional input type`,
          nodeId: node.id
        });
      }
    }
  }
  for (const node of graph.nodes) {
    for (const dependency of dependenciesFor(node)) {
      if (!ids.has(dependency)) {
        issues.push({
          severity: "error",
          code: "node.dependency.missing",
          message: `node ${node.id} depends on missing node ${dependency}`,
          nodeId: node.id
        });
      }
    }
    for (const dependency of inputNodeIds(node)) {
      if ((node.inputs ?? []).some((input) => "nodeId" in input && input.nodeId === dependency && input.type !== undefined)) {
        const source = nodesById(graph).get(dependency);
        const requested = (node.inputs ?? [])
          .filter((input): input is { nodeId: string; type: string } => "nodeId" in input && input.nodeId === dependency && input.type !== undefined)
          .map((input) => input.type);
        for (const type of requested) {
          if (source !== undefined && !source.operator.spec.outputTypes.includes(type)) {
            issues.push({
              severity: "error",
              code: "node.input.type-mismatch",
              message: `node ${node.id} requests type ${type} from ${dependency}, but that node does not emit it`,
              nodeId: node.id
            });
          }
        }
      }
    }
  }
  try {
    topoLayers(graph);
  } catch (error) {
    issues.push({
      severity: "error",
      code: "graph.cycle",
      message: error instanceof Error ? error.message : String(error)
    });
  }
  return issues;
}

export function validateSchedulerGraph(graph: OperatorGraph, scheduler: Scheduler): GraphValidationIssue[] {
  const issues = validateOperatorGraph(graph);
  if (scheduler.family === "direct-fast-path" && graph.nodes.length !== 1) {
    issues.push({
      severity: "error",
      code: "scheduler.direct.node-count",
      message: "DirectFastPathScheduler requires exactly one node"
    });
  }
  return issues;
}

export function assertValidOperatorGraph(graph: OperatorGraph): void {
  const errors = validateOperatorGraph(graph).filter((issue) => issue.severity === "error");
  if (errors.length > 0) {
    throw new Error(errors.map((issue) => issue.message).join("; "));
  }
}

export function explainGraph(graph: OperatorGraph): GraphExplanation {
  const issues = validateOperatorGraph(graph);
  let layers: string[][] = [];
  try {
    layers = topoLayers(graph).map((layer) => layer.map((node) => node.id));
  } catch {
    layers = [];
  }
  const dependedOn = new Set<string>();
  for (const node of graph.nodes) {
    for (const dependency of dependenciesFor(node)) dependedOn.add(dependency);
  }
  return {
    graphId: graph.id,
    nodeCount: graph.nodes.length,
    layers,
    terminalNodeIds: graph.nodes.map((node) => node.id).filter((id) => !dependedOn.has(id)),
    issues
  };
}
