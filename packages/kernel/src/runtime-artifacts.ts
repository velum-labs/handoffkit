import type { Artifact, CreateArtifactInput, Provenance } from "./types.js";

let defaultArtifactIdCounter = 0;

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
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


