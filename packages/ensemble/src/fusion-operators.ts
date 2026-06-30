import type { EnsembleModel } from "./harness.js";
import type {
  Artifact,
  ArtifactLeakage,
  ArtifactVisibility,
  Operator,
  OperatorRunContext,
  OperatorSideEffects,
  OperatorSpec,
  TaskSpec
} from "./runtime.js";

export type ChatMessage = {
  role: string;
  content: unknown;
};

export type ModelGenerateRequest = {
  model: string;
  messages: ChatMessage[];
  prompt: string;
  metadata?: Record<string, unknown>;
};

export type ModelGenerateOutput = {
  model: string;
  content: string;
  raw?: unknown;
  usage?: unknown;
  metadata?: Record<string, unknown>;
};

export type ModelClient = {
  generate(input: ModelGenerateRequest, ctx: OperatorRunContext): Promise<ModelGenerateOutput> | ModelGenerateOutput;
};

export type CandidateArtifactValue = {
  candidateId: string;
  modelId: string;
  model: string;
  content: string;
  raw?: unknown;
  metadata?: Record<string, unknown>;
};

export type PanelCandidate = {
  candidateId?: string;
  modelId: string;
  model?: string;
  content: string;
  raw?: unknown;
  metadata?: Record<string, unknown>;
};

export type PanelRunInput = {
  task: TaskSpec;
  models: readonly EnsembleModel[];
  ctx: OperatorRunContext;
};

export type PanelRunner = (input: PanelRunInput) => Promise<PanelCandidate[]> | PanelCandidate[];

export type JudgeComparison = {
  selectedCandidateId?: string;
  ranking?: Array<{ candidateId: string; score: number; reason?: string }>;
  rationale?: string;
  raw?: unknown;
  metadata?: Record<string, unknown>;
};

export type JudgeComparator = (input: {
  task: TaskSpec;
  candidates: CandidateArtifactValue[];
  ctx: OperatorRunContext;
}) => Promise<JudgeComparison> | JudgeComparison;

export type SynthesisOutput = {
  content: string;
  selectedCandidateId?: string;
  rationale?: string;
  raw?: unknown;
  metadata?: Record<string, unknown>;
};

export type Synthesizer = (input: {
  task: TaskSpec;
  candidates: CandidateArtifactValue[];
  comparison?: JudgeComparison;
  ctx: OperatorRunContext;
}) => Promise<SynthesisOutput> | SynthesisOutput;

function spec(input: {
  id: string;
  kind: string;
  inputTypes: string[];
  outputTypes: string[];
  sideEffects?: OperatorSideEffects;
  candidates?: number;
}): OperatorSpec {
  return {
    id: input.id,
    kind: input.kind,
    inputTypes: input.inputTypes,
    outputTypes: input.outputTypes,
    sideEffects: input.sideEffects ?? "none",
    expectedCost: { candidates: input.candidates ?? 0 }
  };
}

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || "artifact";
}

function taskFromInputs(inputs: readonly Artifact[]): TaskSpec {
  const task = inputs.find((artifact) => artifact.type === "task");
  if (task === undefined) return {};
  if (task.value !== null && typeof task.value === "object") return task.value as TaskSpec;
  if (typeof task.value === "string") return { prompt: task.value };
  return {};
}

function promptFromTask(task: TaskSpec): string {
  if (task.prompt !== undefined) return task.prompt;
  return (task.messages ?? [])
    .map((message) => (typeof message.content === "string" ? message.content : ""))
    .filter((content) => content.length > 0)
    .join("\n");
}

function messagesFromTask(task: TaskSpec): ChatMessage[] {
  if (task.messages !== undefined) return task.messages;
  const prompt = promptFromTask(task);
  return prompt.length > 0 ? [{ role: "user", content: prompt }] : [];
}

function candidateFromArtifact(artifact: Artifact): CandidateArtifactValue | undefined {
  if (artifact.type !== "candidate") return undefined;
  const value = artifact.value;
  if (value === null || typeof value !== "object") return undefined;
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

function candidatesFromInputs(inputs: readonly Artifact[]): CandidateArtifactValue[] {
  return inputs.map(candidateFromArtifact).filter((candidate): candidate is CandidateArtifactValue => candidate !== undefined);
}

function comparisonFromInputs(inputs: readonly Artifact[]): JudgeComparison | undefined {
  const artifact = inputs.find((candidate) => candidate.type === "judge_comparison");
  if (artifact === undefined || artifact.value === null || typeof artifact.value !== "object") return undefined;
  return artifact.value as JudgeComparison;
}

export class ModelGenerateOperator implements Operator {
  readonly spec: OperatorSpec;
  readonly #model: string;
  readonly #modelId: string;
  readonly #client: ModelClient;
  readonly #visibility: ArtifactVisibility;
  readonly #leakage: ArtifactLeakage;

  constructor(options: {
    id?: string;
    model: string;
    modelId?: string;
    client: ModelClient;
    visibility?: ArtifactVisibility;
    leakage?: ArtifactLeakage;
  }) {
    this.#model = options.model;
    this.#modelId = options.modelId ?? options.model;
    this.#client = options.client;
    this.#visibility = options.visibility ?? "runtime";
    this.#leakage = options.leakage ?? "none";
    this.spec = spec({
      id: options.id ?? `model.generate.${slug(this.#modelId)}`,
      kind: "model.generate",
      inputTypes: ["task"],
      outputTypes: ["candidate"],
      candidates: 1
    });
  }

  async run(inputs: readonly Artifact[], ctx: OperatorRunContext): Promise<readonly Artifact[]> {
    const task = taskFromInputs(inputs);
    const output = await this.#client.generate(
      {
        model: this.#model,
        messages: messagesFromTask(task),
        prompt: promptFromTask(task),
        ...(task.metadata !== undefined ? { metadata: task.metadata } : {})
      },
      ctx
    );
    const candidateId = this.#modelId;
    const value: CandidateArtifactValue = {
      candidateId,
      modelId: this.#modelId,
      model: output.model,
      content: output.content,
      ...(output.raw !== undefined ? { raw: output.raw } : {}),
      ...(output.metadata !== undefined || output.usage !== undefined
        ? { metadata: { ...(output.metadata ?? {}), ...(output.usage !== undefined ? { usage: output.usage } : {}) } }
        : {})
    };
    return [
      ctx.createArtifact({
        id: `${this.spec.id}.candidate.${slug(candidateId)}`,
        type: "candidate",
        value,
        visibility: this.#visibility,
        leakage: this.#leakage,
        contentType: "text/plain"
      })
    ];
  }
}

export class PanelGenerateOperator implements Operator {
  readonly spec: OperatorSpec;
  readonly #models: readonly EnsembleModel[];
  readonly #runner: PanelRunner;
  readonly #visibility: ArtifactVisibility;
  readonly #leakage: ArtifactLeakage;
  readonly #sideEffects: OperatorSideEffects;

  constructor(options: {
    id?: string;
    models: readonly EnsembleModel[];
    runner: PanelRunner;
    visibility?: ArtifactVisibility;
    leakage?: ArtifactLeakage;
    sideEffects?: OperatorSideEffects;
  }) {
    this.#models = options.models;
    this.#runner = options.runner;
    this.#visibility = options.visibility ?? "runtime";
    this.#leakage = options.leakage ?? "none";
    this.#sideEffects = options.sideEffects ?? "none";
    this.spec = spec({
      id: options.id ?? "panel.generate",
      kind: "panel.generate",
      inputTypes: ["task"],
      outputTypes: ["candidate"],
      sideEffects: this.#sideEffects,
      candidates: options.models.length
    });
  }

  async run(inputs: readonly Artifact[], ctx: OperatorRunContext): Promise<readonly Artifact[]> {
    const task = taskFromInputs(inputs);
    const candidates = await this.#runner({ task, models: this.#models, ctx });
    return candidates.map((candidate, index) => {
      const model = candidate.model ?? this.#models.find((entry) => entry.id === candidate.modelId)?.model ?? candidate.modelId;
      const candidateId = candidate.candidateId ?? candidate.modelId;
      const value: CandidateArtifactValue = {
        candidateId,
        modelId: candidate.modelId,
        model,
        content: candidate.content,
        ...(candidate.raw !== undefined ? { raw: candidate.raw } : {}),
        ...(candidate.metadata !== undefined ? { metadata: candidate.metadata } : {})
      };
      return ctx.createArtifact({
        id: `${this.spec.id}.candidate.${index + 1}.${slug(candidateId)}`,
        type: "candidate",
        value,
        visibility: this.#visibility,
        leakage: this.#leakage,
        contentType: "application/json"
      });
    });
  }
}

export class JudgeCompareOperator implements Operator {
  readonly spec: OperatorSpec;
  readonly #compare: JudgeComparator;
  readonly #visibility: ArtifactVisibility;
  readonly #leakage: ArtifactLeakage;

  constructor(options: {
    id?: string;
    compare: JudgeComparator;
    visibility?: ArtifactVisibility;
    leakage?: ArtifactLeakage;
  }) {
    this.#compare = options.compare;
    this.#visibility = options.visibility ?? "runtime";
    this.#leakage = options.leakage ?? "public";
    this.spec = spec({
      id: options.id ?? "judge.compare",
      kind: "judge.compare",
      inputTypes: ["task", "candidate"],
      outputTypes: ["judge_comparison"]
    });
  }

  async run(inputs: readonly Artifact[], ctx: OperatorRunContext): Promise<readonly Artifact[]> {
    const task = taskFromInputs(inputs);
    const comparison = await this.#compare({
      task,
      candidates: candidatesFromInputs(inputs),
      ctx
    });
    return [
      ctx.createArtifact({
        id: `${this.spec.id}.comparison`,
        type: "judge_comparison",
        value: comparison,
        visibility: this.#visibility,
        leakage: this.#leakage,
        contentType: "application/json"
      })
    ];
  }
}

export class SynthesizeOperator implements Operator {
  readonly spec: OperatorSpec;
  readonly #synthesize: Synthesizer;
  readonly #visibility: ArtifactVisibility;
  readonly #leakage: ArtifactLeakage;

  constructor(options: {
    id?: string;
    synthesize: Synthesizer;
    visibility?: ArtifactVisibility;
    leakage?: ArtifactLeakage;
  }) {
    this.#synthesize = options.synthesize;
    this.#visibility = options.visibility ?? "user";
    this.#leakage = options.leakage ?? "none";
    this.spec = spec({
      id: options.id ?? "synthesize",
      kind: "synthesize",
      inputTypes: ["task", "candidate"],
      outputTypes: ["final_answer"]
    });
  }

  async run(inputs: readonly Artifact[], ctx: OperatorRunContext): Promise<readonly Artifact[]> {
    const task = taskFromInputs(inputs);
    const output = await this.#synthesize({
      task,
      candidates: candidatesFromInputs(inputs),
      comparison: comparisonFromInputs(inputs),
      ctx
    });
    return [
      ctx.createArtifact({
        id: `${this.spec.id}.final_answer`,
        type: "final_answer",
        value: output,
        visibility: this.#visibility,
        leakage: this.#leakage,
        contentType: "text/markdown"
      })
    ];
  }
}
