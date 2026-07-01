import type { EnsembleModel } from "./harness.js";
import { ArtifactTypes, OperatorKinds } from "./artifact-types.js";
import {
  candidatesFromInputs,
  firstArtifactByType,
  taskFromInputs
} from "./kernel-helpers.js";
import type {
  Artifact,
  ArtifactLeakage,
  ArtifactVisibility,
  Operator,
  OperatorRunContext,
  OperatorSideEffects,
  OperatorSpec,
  RuntimeEvent,
  StreamingOperator,
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
  streamGenerate?(
    input: ModelGenerateRequest,
    ctx: OperatorRunContext
  ): AsyncIterable<string | RuntimeEvent | ModelGenerateOutput>;
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
  inputTypes?: string[];
  requiredInputTypes?: string[];
  optionalInputTypes?: string[];
  outputTypes: string[];
  sideEffects?: OperatorSideEffects;
  candidates?: number;
}): OperatorSpec {
  return {
    id: input.id,
    kind: input.kind,
    ...(input.inputTypes !== undefined ? { inputTypes: input.inputTypes } : {}),
    ...(input.requiredInputTypes !== undefined ? { requiredInputTypes: input.requiredInputTypes } : {}),
    ...(input.optionalInputTypes !== undefined ? { optionalInputTypes: input.optionalInputTypes } : {}),
    outputTypes: input.outputTypes,
    sideEffects: input.sideEffects ?? "none",
    expectedCost: { candidates: input.candidates ?? 0 }
  };
}

function slug(value: string): string {
  let out = "";
  let lastWasUnderscore = false;
  for (const char of value) {
    const code = char.charCodeAt(0);
    const safe =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      char === "." ||
      char === "-";
    if (safe) {
      out += char;
      lastWasUnderscore = false;
    } else if (!lastWasUnderscore) {
      out += "_";
      lastWasUnderscore = true;
    }
  }
  let start = 0;
  let end = out.length;
  while (start < end && out[start] === "_") start += 1;
  while (end > start && out[end - 1] === "_") end -= 1;
  return out.slice(start, end) || "artifact";
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

function comparisonFromInputs(inputs: readonly Artifact[]): JudgeComparison | undefined {
  return firstArtifactByType<JudgeComparison>(inputs, ArtifactTypes.JudgeComparison);
}

export class ModelGenerateOperator implements StreamingOperator {
  readonly spec: OperatorSpec;
  readonly #model: string;
  readonly #modelId: string;
  readonly #client: ModelClient;
  readonly #visibility: ArtifactVisibility;
  readonly #leakage: ArtifactLeakage;
  readonly #streamed = new Map<string, ModelGenerateOutput>();

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
      kind: OperatorKinds.ModelGenerate,
      requiredInputTypes: [ArtifactTypes.Task],
      outputTypes: [ArtifactTypes.Candidate],
      candidates: 1
    });
  }

  async run(inputs: readonly Artifact[], ctx: OperatorRunContext): Promise<readonly Artifact[]> {
    const task = taskFromInputs(inputs);
    const request = {
      model: this.#model,
      messages: messagesFromTask(task),
      prompt: promptFromTask(task),
      ...(task.metadata !== undefined ? { metadata: task.metadata } : {})
    };
    const streamKey = `${ctx.runId}:${ctx.nodeId}`;
    const output = this.#streamed.get(streamKey) ?? (await this.#client.generate(request, ctx));
    this.#streamed.delete(streamKey);
    return this.#candidateArtifact(output, ctx);
  }

  async *stream(inputs: readonly Artifact[], ctx: OperatorRunContext): AsyncIterable<RuntimeEvent> {
    const task = taskFromInputs(inputs);
    const request = {
      model: this.#model,
      messages: messagesFromTask(task),
      prompt: promptFromTask(task),
      ...(task.metadata !== undefined ? { metadata: task.metadata } : {})
    };
    const streamGenerate = this.#client.streamGenerate;
    if (streamGenerate === undefined) {
      const output = await this.#client.generate(request, ctx);
      this.#streamed.set(`${ctx.runId}:${ctx.nodeId}`, output);
      yield { type: "output.delta", content: output.content };
      return;
    }
    let content = "";
    let finalOutput: ModelGenerateOutput | undefined;
    for await (const item of streamGenerate(request, ctx)) {
      if (typeof item === "string") {
        content += item;
        yield { type: "output.delta", content: item };
      } else if ("type" in item) {
        if (item.type === "output.delta") content += item.content;
        yield item;
      } else {
        finalOutput = item;
      }
    }
    this.#streamed.set(
      `${ctx.runId}:${ctx.nodeId}`,
      finalOutput ?? {
        model: this.#model,
        content
      }
    );
  }

  #candidateArtifact(output: ModelGenerateOutput, ctx: OperatorRunContext): readonly Artifact[] {
    const candidateId = `${this.#modelId}:sample:${ctx.nodeId}`;
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
        id: `${ctx.nodeId}.${this.spec.id}.candidate.${slug(candidateId)}`,
        type: ArtifactTypes.Candidate,
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
      kind: OperatorKinds.PanelGenerate,
      requiredInputTypes: [ArtifactTypes.Task],
      outputTypes: [ArtifactTypes.Candidate],
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
        type: ArtifactTypes.Candidate,
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
      kind: OperatorKinds.JudgeCompare,
      requiredInputTypes: [ArtifactTypes.Task, ArtifactTypes.Candidate],
      outputTypes: [ArtifactTypes.JudgeComparison]
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
        type: ArtifactTypes.JudgeComparison,
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
      kind: OperatorKinds.Synthesize,
      requiredInputTypes: [ArtifactTypes.Task, ArtifactTypes.Candidate],
      optionalInputTypes: [ArtifactTypes.JudgeComparison],
      outputTypes: [ArtifactTypes.FinalAnswer]
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
        type: ArtifactTypes.FinalAnswer,
        value: output,
        visibility: this.#visibility,
        leakage: this.#leakage,
        contentType: "text/markdown"
      })
    ];
  }
}
