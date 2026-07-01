import type { ArtifactInputRef, OperatorGraph, OperatorGraphNode } from "./runtime.js";

export function artifactRef(artifactId: string): ArtifactInputRef {
  return { artifactId };
}

export function nodeRef(nodeId: string, type?: string): ArtifactInputRef {
  return type === undefined ? { nodeId } : { nodeId, type };
}

export function inputNodeIds(node: OperatorGraphNode): string[] {
  return (node.inputs ?? []).flatMap((input) => ("nodeId" in input ? [input.nodeId] : []));
}

export function dependenciesFor(node: OperatorGraphNode): string[] {
  return [...(node.dependsOn ?? []), ...inputNodeIds(node)];
}

export function terminalNodeIds(graph: OperatorGraph): string[] {
  const dependedOn = new Set<string>();
  for (const node of graph.nodes) {
    for (const dependency of dependenciesFor(node)) dependedOn.add(dependency);
  }
  return graph.nodes.map((node) => node.id).filter((id) => !dependedOn.has(id));
}

export function nodesById(graph: OperatorGraph): Map<string, OperatorGraphNode> {
  return new Map(graph.nodes.map((node) => [node.id, node]));
}

export function topoLayers(graph: OperatorGraph): OperatorGraphNode[][] {
  const remaining = nodesById(graph);
  const completed = new Set<string>();
  const layers: OperatorGraphNode[][] = [];
  while (remaining.size > 0) {
    const layer = [...remaining.values()].filter((node) =>
      dependenciesFor(node).every((dependency) => completed.has(dependency))
    );
    if (layer.length === 0) {
      throw new Error(`operator graph ${graph.id} has a cycle or unsatisfied dependencies: ${[...remaining.keys()].join(", ")}`);
    }
    layers.push(layer);
    for (const node of layer) {
      completed.add(node.id);
      remaining.delete(node.id);
    }
  }
  return layers;
}

export function countOperatorKind(graph: OperatorGraph, kind: string): number {
  return graph.nodes.filter((node) => node.operator.spec.kind === kind).length;
}

export function nodeOutputRefs(graph: OperatorGraph, nodeId: string): ArtifactInputRef[] {
  const node = nodesById(graph).get(nodeId);
  return (node?.operator.spec.outputTypes ?? []).map((type) => nodeRef(nodeId, type));
}
