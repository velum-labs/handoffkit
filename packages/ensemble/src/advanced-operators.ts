import type {
  Artifact,
  ArtifactLeakage,
  ArtifactVisibility,
  Operator,
  OperatorRunContext,
  OperatorSideEffects,
  OperatorSpec,
  RecordObservationInput,
  RecordSignalInput,
  TaskSpec
} from "./runtime.js";

import type {
  CandidateArtifactValue,
  JudgeComparison,
  SynthesisOutput
} from "./fusion-operators.js";

export type EvidenceBundle = {
  observations: string[];
  signals: string[];
  summary?: string;
  metadata?: Record<string, unknown>;
};

export type RankMatrix = {
  rankings: Array<{ candidateId: string; score: number; reason?: string }>;
  pairwise?: Array<{ leftCandidateId: string; rightCandidateId: string; winnerCandidateId: string; reason?: string }>;
  metadata?: Record<string, unknown>;
};

export type SelectedCandidate = {
  candidate: CandidateArtifactValue;
  reason?: string;
  score?: number;
  metadata?: Record<string, unknown>;
};

export type RepairOutput = {
  candidate: CandidateArtifactValue;
  evidenceArtifactIds?: string[];
  metadata?: Record<string, unknown>;
};

export type RouteDecision = {
  routeId: string;
  targetNodeId?: string;
  modelId?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
};

export type DelegationResult = {
  role: string;
  output: unknown;
  artifactIds?: string[];
  metadata?: Record<string, unknown>;
};

export type ReviewResult = {
  verdict: "approve" | "revise" | "reject";
  summary: string;
  findings?: Array<{ severity: "low" | "medium" | "high"; message: string; artifactId?: string }>;
  metadata?: Record<string, unknown>;
};

export type TreeNodeValue = {
  nodeId: string;
  parentNodeId?: string;
  content: unknown;
  depth: number;
  metadata?: Record<string, unknown>;
};

export type ArchitectureEvaluation = {
  architectureId: string;
  score: number;
  metrics?: Record<string, number>;
  metadata?: Record<string, unknown>;
};

export type MergeRecipe = {
  recipeId: string;
  modelIds: string[];
  steps: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
};

export type EvidenceSource = (input: {
  task: TaskSpec;
  candidates: CandidateArtifactValue[];
  ctx: OperatorRunContext;
}) =>
  | {
      observations?: RecordObservationInput[];
      signals?: RecordSignalInput[];
      summary?: string;
      metadata?: Record<string, unknown>;
    }
  | Promise<{
      observations?: RecordObservationInput[];
      signals?: RecordSignalInput[];
      summary?: string;
      metadata?: Record<string, unknown>;
    }>;

export type SignalCalibrator = (input: {
  task: TaskSpec;
  candidates: CandidateArtifactValue[];
  evidence: EvidenceBundle[];
  ctx: OperatorRunContext;
}) => RecordSignalInput[] | Promise<RecordSignalInput[]>;

export type CandidateSelector = (input: {
  task: TaskSpec;
  candidates: CandidateArtifactValue[];
  comparison?: JudgeComparison;
  rankMatrix?: RankMatrix;
  evidence: EvidenceBundle[];
  ctx: OperatorRunContext;
}) => SelectedCandidate | Promise<SelectedCandidate>;

export type CandidateRepairer = (input: {
  task: TaskSpec;
  selected?: SelectedCandidate;
  candidates: CandidateArtifactValue[];
  evidence: EvidenceBundle[];
  ctx: OperatorRunContext;
}) => RepairOutput | Promise<RepairOutput>;

function spec(input: {
  id: string;
  kind: string;
  inputTypes: string[];
  outputTypes: string[];
  sideEffects?: OperatorSideEffects;
}): OperatorSpec {
  return {
    id: input.id,
    kind: input.kind,
    inputTypes: input.inputTypes,
    outputTypes: input.outputTypes,
    sideEffects: input.sideEffects ?? "none"
  };
}

function taskFromInputs(inputs: readonly Artifact[]): TaskSpec {
  const task = inputs.find((artifact) => artifact.type === "task");
  if (task?.value !== null && typeof task?.value === "object") return task.value as TaskSpec;
  if (typeof task?.value === "string") return { prompt: task.value };
  return {};
}

function candidateFromArtifact(artifact: Artifact): CandidateArtifactValue | undefined {
  const value = artifact.value as Partial<CandidateArtifactValue> | undefined;
  if (
    artifact.type === "candidate" &&
    value !== undefined &&
    typeof value.candidateId === "string" &&
    typeof value.modelId === "string" &&
    typeof value.model === "string" &&
    typeof value.content === "string"
  ) {
    return {
      candidateId: value.candidateId,
      modelId: value.modelId,
      model: value.model,
      content: value.content,
      ...(value.raw !== undefined ? { raw: value.raw } : {}),
      ...(value.metadata !== undefined ? { metadata: value.metadata } : {})
    };
  }
  return undefined;
}

function candidatesFromInputs(inputs: readonly Artifact[]): CandidateArtifactValue[] {
  return inputs.map(candidateFromArtifact).filter((candidate): candidate is CandidateArtifactValue => candidate !== undefined);
}

function evidenceFromInputs(inputs: readonly Artifact[]): EvidenceBundle[] {
  return inputs
    .filter((artifact) => artifact.type === "evidence_bundle")
    .map((artifact) => artifact.value as EvidenceBundle);
}

function comparisonFromInputs(inputs: readonly Artifact[]): JudgeComparison | undefined {
  const artifact = inputs.find((entry) => entry.type === "judge_comparison");
  return artifact?.value !== null && typeof artifact?.value === "object" ? (artifact.value as JudgeComparison) : undefined;
}

function rankMatrixFromInputs(inputs: readonly Artifact[]): RankMatrix | undefined {
  const artifact = inputs.find((entry) => entry.type === "rank_matrix");
  return artifact?.value !== null && typeof artifact?.value === "object" ? (artifact.value as RankMatrix) : undefined;
}

function selectedFromInputs(inputs: readonly Artifact[]): SelectedCandidate | undefined {
  const artifact = inputs.find((entry) => entry.type === "selected_candidate");
  return artifact?.value !== null && typeof artifact?.value === "object" ? (artifact.value as SelectedCandidate) : undefined;
}

function firstCandidate(candidates: CandidateArtifactValue[]): SelectedCandidate {
  const candidate = candidates[0];
  if (candidate === undefined) throw new Error("no candidates available to select");
  return { candidate, reason: "first candidate fallback" };
}

function defaultSelect(input: {
  candidates: CandidateArtifactValue[];
  comparison?: JudgeComparison;
  rankMatrix?: RankMatrix;
}): SelectedCandidate {
  const selectedId =
    input.comparison?.selectedCandidateId ??
    [...(input.rankMatrix?.rankings ?? [])].sort((left, right) => right.score - left.score)[0]?.candidateId;
  if (selectedId !== undefined) {
    const candidate = input.candidates.find((entry) => entry.candidateId === selectedId);
    if (candidate !== undefined) return { candidate, reason: "selected by comparison/ranking" };
  }
  return firstCandidate(input.candidates);
}

export class EvidenceSourceOperator implements Operator {
  readonly spec: OperatorSpec;
  readonly #source: EvidenceSource;
  readonly #visibility: ArtifactVisibility;
  readonly #leakage: ArtifactLeakage;

  constructor(options: { id?: string; source: EvidenceSource; visibility?: ArtifactVisibility; leakage?: ArtifactLeakage }) {
    this.#source = options.source;
    this.#visibility = options.visibility ?? "runtime";
    this.#leakage = options.leakage ?? "public";
    this.spec = spec({
      id: options.id ?? "evidence.source",
      kind: "evidence",
      inputTypes: ["task", "candidate"],
      outputTypes: ["evidence_bundle"]
    });
  }

  async run(inputs: readonly Artifact[], ctx: OperatorRunContext): Promise<readonly Artifact[]> {
    const result = await this.#source({ task: taskFromInputs(inputs), candidates: candidatesFromInputs(inputs), ctx });
    const observations = (result.observations ?? []).map((observation) => ctx.recordObservation(observation).id);
    const signals = (result.signals ?? []).map((signal) => ctx.recordSignal(signal).id);
    return [
      ctx.createArtifact({
        id: `${this.spec.id}.bundle`,
        type: "evidence_bundle",
        value: {
          observations,
          signals,
          ...(result.summary !== undefined ? { summary: result.summary } : {}),
          ...(result.metadata !== undefined ? { metadata: result.metadata } : {})
        } satisfies EvidenceBundle,
        visibility: this.#visibility,
        leakage: this.#leakage,
        contentType: "application/json"
      })
    ];
  }
}

export class CalibrateSignalOperator implements Operator {
  readonly spec: OperatorSpec;
  readonly #calibrator: SignalCalibrator;

  constructor(options: { id?: string; calibrator: SignalCalibrator }) {
    this.#calibrator = options.calibrator;
    this.spec = spec({
      id: options.id ?? "signal.calibrate",
      kind: "calibrate",
      inputTypes: ["task", "candidate", "evidence_bundle"],
      outputTypes: ["evidence_bundle"]
    });
  }

  async run(inputs: readonly Artifact[], ctx: OperatorRunContext): Promise<readonly Artifact[]> {
    const signals = await this.#calibrator({
      task: taskFromInputs(inputs),
      candidates: candidatesFromInputs(inputs),
      evidence: evidenceFromInputs(inputs),
      ctx
    });
    const signalIds = signals.map((signal) => ctx.recordSignal(signal).id);
    return [
      ctx.createArtifact({
        id: `${this.spec.id}.bundle`,
        type: "evidence_bundle",
        value: { observations: [], signals: signalIds } satisfies EvidenceBundle,
        visibility: "runtime",
        leakage: signals.some((signal) => signal.leakageRisk === "private" || signal.leakageRisk === "contaminated")
          ? "private"
          : "public",
        contentType: "application/json"
      })
    ];
  }
}

export class SchemaValidationOperator implements Operator {
  readonly spec: OperatorSpec;
  readonly #validate: (value: unknown) => { passed: boolean; errors?: string[] };

  constructor(options: { id?: string; validate: (value: unknown) => { passed: boolean; errors?: string[] } }) {
    this.#validate = options.validate;
    this.spec = spec({
      id: options.id ?? "schema.validate",
      kind: "evidence",
      inputTypes: ["candidate"],
      outputTypes: ["evidence_bundle"]
    });
  }

  run(inputs: readonly Artifact[], ctx: OperatorRunContext): readonly Artifact[] {
    const observations: string[] = [];
    const signals: string[] = [];
    for (const candidate of inputs.filter((artifact) => artifact.type === "candidate")) {
      const result = this.#validate(candidate.value);
      const observation = ctx.recordObservation({
        sourceId: this.spec.id,
        targetArtifactId: candidate.id,
        type: "schema_validation",
        value: result,
        leakage: "public"
      });
      const signal = ctx.recordSignal({
        targetArtifactId: candidate.id,
        dimension: "format",
        score: result.passed ? 1 : 0,
        confidence: 1,
        calibration: "ground_truth",
        leakageRisk: "public",
        observationIds: [observation.id]
      });
      observations.push(observation.id);
      signals.push(signal.id);
    }
    return [
      ctx.createArtifact({
        id: `${this.spec.id}.bundle`,
        type: "evidence_bundle",
        value: { observations, signals } satisfies EvidenceBundle,
        visibility: "runtime",
        leakage: "public"
      })
    ];
  }
}

export class PairRankOperator implements Operator {
  readonly spec: OperatorSpec;
  readonly #rank: (input: { candidates: CandidateArtifactValue[]; task: TaskSpec; ctx: OperatorRunContext }) => RankMatrix | Promise<RankMatrix>;

  constructor(options: { id?: string; rank: (input: { candidates: CandidateArtifactValue[]; task: TaskSpec; ctx: OperatorRunContext }) => RankMatrix | Promise<RankMatrix> }) {
    this.#rank = options.rank;
    this.spec = spec({
      id: options.id ?? "pair.rank",
      kind: "rank",
      inputTypes: ["task", "candidate"],
      outputTypes: ["rank_matrix"]
    });
  }

  async run(inputs: readonly Artifact[], ctx: OperatorRunContext): Promise<readonly Artifact[]> {
    const matrix = await this.#rank({ candidates: candidatesFromInputs(inputs), task: taskFromInputs(inputs), ctx });
    return [ctx.createArtifact({ id: `${this.spec.id}.matrix`, type: "rank_matrix", value: matrix, visibility: "runtime", leakage: "public" })];
  }
}

export class SelectOperator implements Operator {
  readonly spec: OperatorSpec;
  readonly #selector: CandidateSelector | undefined;

  constructor(options: { id?: string; selector?: CandidateSelector } = {}) {
    this.#selector = options.selector;
    this.spec = spec({
      id: options.id ?? "candidate.select",
      kind: "select",
      inputTypes: ["task", "candidate"],
      outputTypes: ["selected_candidate"]
    });
  }

  async run(inputs: readonly Artifact[], ctx: OperatorRunContext): Promise<readonly Artifact[]> {
    const candidates = candidatesFromInputs(inputs);
    const selected =
      this.#selector !== undefined
        ? await this.#selector({
            task: taskFromInputs(inputs),
            candidates,
            comparison: comparisonFromInputs(inputs),
            rankMatrix: rankMatrixFromInputs(inputs),
            evidence: evidenceFromInputs(inputs),
            ctx
          })
        : defaultSelect({ candidates, comparison: comparisonFromInputs(inputs), rankMatrix: rankMatrixFromInputs(inputs) });
    return [
      ctx.createArtifact({
        id: `${this.spec.id}.selected`,
        type: "selected_candidate",
        value: selected,
        visibility: "runtime",
        leakage: "public"
      })
    ];
  }
}

export class RepairOperator implements Operator {
  readonly spec: OperatorSpec;
  readonly #repair: CandidateRepairer;

  constructor(options: { id?: string; repair: CandidateRepairer; sideEffects?: OperatorSideEffects }) {
    this.#repair = options.repair;
    this.spec = spec({
      id: options.id ?? "candidate.repair",
      kind: "repair",
      inputTypes: ["task", "candidate"],
      outputTypes: ["candidate"],
      sideEffects: options.sideEffects
    });
  }

  async run(inputs: readonly Artifact[], ctx: OperatorRunContext): Promise<readonly Artifact[]> {
    const output = await this.#repair({
      task: taskFromInputs(inputs),
      selected: selectedFromInputs(inputs),
      candidates: candidatesFromInputs(inputs),
      evidence: evidenceFromInputs(inputs),
      ctx
    });
    return [
      ctx.createArtifact({
        id: `${this.spec.id}.${output.candidate.candidateId}`,
        type: "candidate",
        value: output.candidate,
        visibility: "runtime",
        leakage: "public"
      })
    ];
  }
}

export class GenFuserOperator implements Operator {
  readonly spec: OperatorSpec;
  readonly #fuse: (input: { task: TaskSpec; candidates: CandidateArtifactValue[]; selected?: SelectedCandidate; rankMatrix?: RankMatrix; ctx: OperatorRunContext }) => SynthesisOutput | Promise<SynthesisOutput>;

  constructor(options: { id?: string; fuse: (input: { task: TaskSpec; candidates: CandidateArtifactValue[]; selected?: SelectedCandidate; rankMatrix?: RankMatrix; ctx: OperatorRunContext }) => SynthesisOutput | Promise<SynthesisOutput> }) {
    this.#fuse = options.fuse;
    this.spec = spec({
      id: options.id ?? "gen.fuse",
      kind: "fuse",
      inputTypes: ["task", "candidate"],
      outputTypes: ["final_answer"]
    });
  }

  async run(inputs: readonly Artifact[], ctx: OperatorRunContext): Promise<readonly Artifact[]> {
    const output = await this.#fuse({
      task: taskFromInputs(inputs),
      candidates: candidatesFromInputs(inputs),
      selected: selectedFromInputs(inputs),
      rankMatrix: rankMatrixFromInputs(inputs),
      ctx
    });
    return [ctx.createArtifact({ id: `${this.spec.id}.final_answer`, type: "final_answer", value: output, visibility: "user", leakage: "none" })];
  }
}

export class RouteOperator implements Operator {
  readonly spec: OperatorSpec;
  readonly #route: (input: { task: TaskSpec; ctx: OperatorRunContext }) => RouteDecision | Promise<RouteDecision>;

  constructor(options: { id?: string; route: (input: { task: TaskSpec; ctx: OperatorRunContext }) => RouteDecision | Promise<RouteDecision> }) {
    this.#route = options.route;
    this.spec = spec({ id: options.id ?? "route", kind: "route", inputTypes: ["task"], outputTypes: ["route_decision"] });
  }

  async run(inputs: readonly Artifact[], ctx: OperatorRunContext): Promise<readonly Artifact[]> {
    const decision = await this.#route({ task: taskFromInputs(inputs), ctx });
    return [ctx.createArtifact({ id: `${this.spec.id}.decision`, type: "route_decision", value: decision, visibility: "runtime", leakage: "public" })];
  }
}

export class DelegateOperator implements Operator {
  readonly spec: OperatorSpec;
  readonly #delegate: (input: { task: TaskSpec; route?: RouteDecision; ctx: OperatorRunContext }) => DelegationResult | Promise<DelegationResult>;

  constructor(options: {
    id?: string;
    role: string;
    delegate: (input: { task: TaskSpec; route?: RouteDecision; ctx: OperatorRunContext }) => DelegationResult | Promise<DelegationResult>;
    sideEffects?: OperatorSideEffects;
  }) {
    this.#delegate = options.delegate;
    this.spec = spec({
      id: options.id ?? `delegate.${options.role}`,
      kind: "delegate",
      inputTypes: ["task"],
      outputTypes: ["delegation_result"],
      sideEffects: options.sideEffects ?? "read_workspace"
    });
  }

  async run(inputs: readonly Artifact[], ctx: OperatorRunContext): Promise<readonly Artifact[]> {
    const route = inputs.find((artifact) => artifact.type === "route_decision")?.value as RouteDecision | undefined;
    const result = await this.#delegate({ task: taskFromInputs(inputs), route, ctx });
    return [ctx.createArtifact({ id: `${this.spec.id}.result`, type: "delegation_result", value: result, visibility: "runtime", leakage: "public" })];
  }
}

export class ReviewOperator implements Operator {
  readonly spec: OperatorSpec;
  readonly #review: (input: { task: TaskSpec; inputs: readonly Artifact[]; ctx: OperatorRunContext }) => ReviewResult | Promise<ReviewResult>;

  constructor(options: { id?: string; review: (input: { task: TaskSpec; inputs: readonly Artifact[]; ctx: OperatorRunContext }) => ReviewResult | Promise<ReviewResult> }) {
    this.#review = options.review;
    this.spec = spec({ id: options.id ?? "review", kind: "review", inputTypes: ["task"], outputTypes: ["review"] });
  }

  async run(inputs: readonly Artifact[], ctx: OperatorRunContext): Promise<readonly Artifact[]> {
    const review = await this.#review({ task: taskFromInputs(inputs), inputs, ctx });
    return [ctx.createArtifact({ id: `${this.spec.id}.review`, type: "review", value: review, visibility: "developer", leakage: "public" })];
  }
}

export class TreeExpandOperator implements Operator {
  readonly spec: OperatorSpec;
  readonly #expand: (input: { task: TaskSpec; nodes: TreeNodeValue[]; ctx: OperatorRunContext }) => TreeNodeValue[] | Promise<TreeNodeValue[]>;

  constructor(options: { id?: string; expand: (input: { task: TaskSpec; nodes: TreeNodeValue[]; ctx: OperatorRunContext }) => TreeNodeValue[] | Promise<TreeNodeValue[]> }) {
    this.#expand = options.expand;
    this.spec = spec({ id: options.id ?? "tree.expand", kind: "tree.expand", inputTypes: ["task"], outputTypes: ["tree_node"] });
  }

  async run(inputs: readonly Artifact[], ctx: OperatorRunContext): Promise<readonly Artifact[]> {
    const nodes = inputs.filter((artifact) => artifact.type === "tree_node").map((artifact) => artifact.value as TreeNodeValue);
    const expanded = await this.#expand({ task: taskFromInputs(inputs), nodes, ctx });
    return expanded.map((node) => ctx.createArtifact({ id: `${this.spec.id}.${node.nodeId}`, type: "tree_node", value: node, visibility: "runtime", leakage: "public" }));
  }
}

export class TreeScoreOperator implements Operator {
  readonly spec: OperatorSpec;
  readonly #score: (input: { nodes: TreeNodeValue[]; ctx: OperatorRunContext }) => RankMatrix | Promise<RankMatrix>;

  constructor(options: { id?: string; score: (input: { nodes: TreeNodeValue[]; ctx: OperatorRunContext }) => RankMatrix | Promise<RankMatrix> }) {
    this.#score = options.score;
    this.spec = spec({ id: options.id ?? "tree.score", kind: "tree.score", inputTypes: ["tree_node"], outputTypes: ["rank_matrix"] });
  }

  async run(inputs: readonly Artifact[], ctx: OperatorRunContext): Promise<readonly Artifact[]> {
    const matrix = await this.#score({
      nodes: inputs.filter((artifact) => artifact.type === "tree_node").map((artifact) => artifact.value as TreeNodeValue),
      ctx
    });
    return [ctx.createArtifact({ id: `${this.spec.id}.matrix`, type: "rank_matrix", value: matrix, visibility: "runtime", leakage: "public" })];
  }
}

export class ArchitectureEvaluateOperator implements Operator {
  readonly spec: OperatorSpec;
  readonly #evaluate: (input: { task: TaskSpec; ctx: OperatorRunContext }) => ArchitectureEvaluation | Promise<ArchitectureEvaluation>;

  constructor(options: { id?: string; evaluate: (input: { task: TaskSpec; ctx: OperatorRunContext }) => ArchitectureEvaluation | Promise<ArchitectureEvaluation> }) {
    this.#evaluate = options.evaluate;
    this.spec = spec({ id: options.id ?? "architecture.evaluate", kind: "architecture.evaluate", inputTypes: ["task"], outputTypes: ["architecture_result"] });
  }

  async run(inputs: readonly Artifact[], ctx: OperatorRunContext): Promise<readonly Artifact[]> {
    const result = await this.#evaluate({ task: taskFromInputs(inputs), ctx });
    return [ctx.createArtifact({ id: `${this.spec.id}.result`, type: "architecture_result", value: result, visibility: "developer", leakage: "private" })];
  }
}

export class OfflineModelMergeOperator implements Operator {
  readonly spec: OperatorSpec;
  readonly #merge: (input: { task: TaskSpec; ctx: OperatorRunContext }) => MergeRecipe | Promise<MergeRecipe>;

  constructor(options: { id?: string; merge: (input: { task: TaskSpec; ctx: OperatorRunContext }) => MergeRecipe | Promise<MergeRecipe> }) {
    this.#merge = options.merge;
    this.spec = spec({ id: options.id ?? "model.merge.recipe", kind: "model.merge", inputTypes: ["task"], outputTypes: ["merge_recipe"] });
  }

  async run(inputs: readonly Artifact[], ctx: OperatorRunContext): Promise<readonly Artifact[]> {
    const recipe = await this.#merge({ task: taskFromInputs(inputs), ctx });
    return [ctx.createArtifact({ id: `${this.spec.id}.${recipe.recipeId}`, type: "merge_recipe", value: recipe, visibility: "developer", leakage: "private" })];
  }
}
