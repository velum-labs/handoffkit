import { ArtifactTypes } from "./artifact-types.js";
import { createArtifact } from "./runtime.js";
import type {
  Artifact,
  ArtifactLeakage,
  ArtifactVisibility,
  Operator,
  OperatorRunContext,
  OperatorSpec,
  TaskSpec
} from "./runtime.js";
import type { CandidateArtifactValue } from "./fusion-operators.js";

export type CreateTaskArtifactInput = TaskSpec & {
  artifactId?: string;
  visibility?: ArtifactVisibility;
  leakage?: ArtifactLeakage;
};

export function createTaskArtifact(input: CreateTaskArtifactInput): Artifact<TaskSpec> {
  const { artifactId, visibility, leakage, ...task } = input;
  return createArtifact({
    id: artifactId ?? task.id ?? "task",
    type: ArtifactTypes.Task,
    value: task,
    visibility: visibility ?? "runtime",
    leakage: leakage ?? "none"
  });
}

export function defineOperator(
  spec: OperatorSpec,
  run: Operator["run"]
): Operator {
  return { spec, run };
}

export function taskFromInputs(inputs: readonly Artifact[]): TaskSpec {
  const task = inputs.find((artifact) => artifact.type === ArtifactTypes.Task);
  if (task === undefined) return {};
  if (task.value !== null && typeof task.value === "object") return task.value as TaskSpec;
  if (typeof task.value === "string") return { prompt: task.value };
  return {};
}

export function candidateFromArtifact(artifact: Artifact): CandidateArtifactValue | undefined {
  const value = artifact.value;
  if (artifact.type !== ArtifactTypes.Candidate || value === null || typeof value !== "object") return undefined;
  const candidate = value as Partial<CandidateArtifactValue>;
  if (
    typeof candidate.candidateId === "string" &&
    typeof candidate.modelId === "string" &&
    typeof candidate.model === "string" &&
    typeof candidate.content === "string"
  ) {
    return {
      candidateId: candidate.candidateId,
      modelId: candidate.modelId,
      model: candidate.model,
      content: candidate.content,
      ...(candidate.raw !== undefined ? { raw: candidate.raw } : {}),
      ...(candidate.metadata !== undefined ? { metadata: candidate.metadata } : {})
    };
  }
  return undefined;
}

export function candidatesFromInputs(inputs: readonly Artifact[]): CandidateArtifactValue[] {
  return inputs.map(candidateFromArtifact).filter((candidate): candidate is CandidateArtifactValue => candidate !== undefined);
}

export function artifactValue<T>(artifact: Artifact | undefined, type: string): T | undefined {
  return artifact?.type === type ? (artifact.value as T) : undefined;
}

export function firstArtifactByType<T>(inputs: readonly Artifact[], type: string): T | undefined {
  return artifactValue<T>(
    inputs.find((artifact) => artifact.type === type),
    type
  );
}

export function operatorSpec(input: OperatorSpec): OperatorSpec {
  return input;
}

export function consumeUsageFromOutput(output: { usage?: unknown }, ctx: OperatorRunContext): void {
  const usage = output.usage;
  if (usage === null || typeof usage !== "object") return;
  const record = usage as { inputTokens?: unknown; outputTokens?: unknown; costUsd?: unknown };
  ctx.consumeBudget({
    ...(typeof record.inputTokens === "number" ? { inputTokens: record.inputTokens } : {}),
    ...(typeof record.outputTokens === "number" ? { outputTokens: record.outputTokens } : {}),
    ...(typeof record.costUsd === "number" ? { usd: record.costUsd } : {})
  });
}
