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
import { ArtifactTypes, OperatorKinds } from "./artifact-types.js";
import {
  candidatesFromInputs,
  firstArtifactByType,
  taskFromInputs
} from "./kernel-helpers.js";

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
  inputTypes?: string[];
  requiredInputTypes?: string[];
  optionalInputTypes?: string[];
  outputTypes: string[];
  sideEffects?: OperatorSideEffects;
}): OperatorSpec {
  return {
    id: input.id,
    kind: input.kind,
    ...(input.inputTypes !== undefined ? { inputTypes: input.inputTypes } : {}),
    ...(input.requiredInputTypes !== undefined ? { requiredInputTypes: input.requiredInputTypes } : {}),
    ...(input.optionalInputTypes !== undefined ? { optionalInputTypes: input.optionalInputTypes } : {}),
    outputTypes: input.outputTypes,
    sideEffects: input.sideEffects ?? "none"
  };
}

function evidenceFromInputs(inputs: readonly Artifact[]): EvidenceBundle[] {
  return inputs
    .filter((artifact) => artifact.type === ArtifactTypes.EvidenceBundle)
    .map((artifact) => artifact.value as EvidenceBundle);
}

function comparisonFromInputs(inputs: readonly Artifact[]): JudgeComparison | undefined {
  return firstArtifactByType<JudgeComparison>(inputs, ArtifactTypes.JudgeComparison);
}

function rankMatrixFromInputs(inputs: readonly Artifact[]): RankMatrix | undefined {
  return firstArtifactByType<RankMatrix>(inputs, ArtifactTypes.RankMatrix);
}

function selectedFromInputs(inputs: readonly Artifact[]): SelectedCandidate | undefined {
  return firstArtifactByType<SelectedCandidate>(inputs, ArtifactTypes.SelectedCandidate);
}

function selectFromEvidence(input: {
  candidates: CandidateArtifactValue[];
  comparison?: JudgeComparison;
  rankMatrix?: RankMatrix;
}): SelectedCandidate {
  if (input.candidates.length === 0) throw new Error("selection requires at least one candidate");
  const selectedId =
    input.comparison?.selectedCandidateId ??
    [...(input.rankMatrix?.rankings ?? [])].sort((left, right) => right.score - left.score)[0]?.candidateId;
  if (selectedId !== undefined) {
    const candidate = input.candidates.find((entry) => entry.candidateId === selectedId);
    if (candidate !== undefined) return { candidate, reason: "selected by comparison/ranking" };
    throw new Error(`selection referenced missing candidate ${selectedId}`);
  }
  throw new Error("selection requires an explicit comparison, rank matrix, or selector policy");
}

function assertScore(name: string, score: number): void {
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    throw new Error(`${name} score must be between 0 and 1`);
  }
}

function validateRankMatrix(matrix: RankMatrix): void {
  const seen = new Set<string>();
  for (const ranking of matrix.rankings) {
    if (ranking.candidateId.length === 0) throw new Error("rank matrix candidateId must be non-empty");
    if (seen.has(ranking.candidateId)) throw new Error(`rank matrix duplicates candidate ${ranking.candidateId}`);
    seen.add(ranking.candidateId);
    assertScore(`rank matrix ${ranking.candidateId}`, ranking.score);
  }
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
      kind: OperatorKinds.Evidence,
      requiredInputTypes: [ArtifactTypes.Task, ArtifactTypes.Candidate],
      outputTypes: [ArtifactTypes.EvidenceBundle]
    });
  }

  async run(inputs: readonly Artifact[], ctx: OperatorRunContext): Promise<readonly Artifact[]> {
    const result = await this.#source({ task: taskFromInputs(inputs), candidates: candidatesFromInputs(inputs), ctx });
    const observations = (result.observations ?? []).map((observation) => ctx.recordObservation(observation).id);
    const signals = (result.signals ?? []).map((signal) => ctx.recordSignal(signal).id);
    return [
      ctx.createArtifact({
        id: `${this.spec.id}.bundle`,
        type: ArtifactTypes.EvidenceBundle,
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
      kind: OperatorKinds.Calibrate,
      requiredInputTypes: [ArtifactTypes.Task, ArtifactTypes.Candidate, ArtifactTypes.EvidenceBundle],
      outputTypes: [ArtifactTypes.EvidenceBundle]
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
        type: ArtifactTypes.EvidenceBundle,
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
      kind: OperatorKinds.Evidence,
      requiredInputTypes: [ArtifactTypes.Candidate],
      outputTypes: [ArtifactTypes.EvidenceBundle]
    });
  }

  run(inputs: readonly Artifact[], ctx: OperatorRunContext): readonly Artifact[] {
    const observations: string[] = [];
    const signals: string[] = [];
    for (const candidate of inputs.filter((artifact) => artifact.type === ArtifactTypes.Candidate)) {
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
        type: ArtifactTypes.EvidenceBundle,
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
      kind: OperatorKinds.Rank,
      requiredInputTypes: [ArtifactTypes.Task, ArtifactTypes.Candidate],
      outputTypes: [ArtifactTypes.RankMatrix]
    });
  }

  async run(inputs: readonly Artifact[], ctx: OperatorRunContext): Promise<readonly Artifact[]> {
    const matrix = await this.#rank({ candidates: candidatesFromInputs(inputs), task: taskFromInputs(inputs), ctx });
    validateRankMatrix(matrix);
    return [ctx.createArtifact({ id: `${this.spec.id}.matrix`, type: ArtifactTypes.RankMatrix, value: matrix, visibility: "runtime", leakage: "public" })];
  }
}

export class SelectOperator implements Operator {
  readonly spec: OperatorSpec;
  readonly #selector: CandidateSelector | undefined;

  constructor(options: { id?: string; selector?: CandidateSelector } = {}) {
    this.#selector = options.selector;
    this.spec = spec({
      id: options.id ?? "candidate.select",
      kind: OperatorKinds.Select,
      requiredInputTypes: [ArtifactTypes.Task, ArtifactTypes.Candidate],
      optionalInputTypes: [ArtifactTypes.JudgeComparison, ArtifactTypes.RankMatrix, ArtifactTypes.EvidenceBundle],
      outputTypes: [ArtifactTypes.SelectedCandidate]
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
        : selectFromEvidence({ candidates, comparison: comparisonFromInputs(inputs), rankMatrix: rankMatrixFromInputs(inputs) });
    return [
      ctx.createArtifact({
        id: `${this.spec.id}.selected`,
        type: ArtifactTypes.SelectedCandidate,
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
      kind: OperatorKinds.Repair,
      requiredInputTypes: [ArtifactTypes.Task, ArtifactTypes.Candidate],
      optionalInputTypes: [ArtifactTypes.SelectedCandidate, ArtifactTypes.EvidenceBundle],
      outputTypes: [ArtifactTypes.Candidate],
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
        type: ArtifactTypes.Candidate,
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
      kind: OperatorKinds.Fuse,
      requiredInputTypes: [ArtifactTypes.Task, ArtifactTypes.Candidate],
      optionalInputTypes: [ArtifactTypes.SelectedCandidate, ArtifactTypes.RankMatrix],
      outputTypes: [ArtifactTypes.FinalAnswer]
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
    return [ctx.createArtifact({ id: `${this.spec.id}.final_answer`, type: ArtifactTypes.FinalAnswer, value: output, visibility: "user", leakage: "none" })];
  }
}

export class RouteOperator implements Operator {
  readonly spec: OperatorSpec;
  readonly #route: (input: { task: TaskSpec; ctx: OperatorRunContext }) => RouteDecision | Promise<RouteDecision>;

  constructor(options: { id?: string; route: (input: { task: TaskSpec; ctx: OperatorRunContext }) => RouteDecision | Promise<RouteDecision> }) {
    this.#route = options.route;
    this.spec = spec({ id: options.id ?? "route", kind: OperatorKinds.Route, requiredInputTypes: [ArtifactTypes.Task], outputTypes: [ArtifactTypes.RouteDecision] });
  }

  async run(inputs: readonly Artifact[], ctx: OperatorRunContext): Promise<readonly Artifact[]> {
    const decision = await this.#route({ task: taskFromInputs(inputs), ctx });
    if (decision.routeId.length === 0) throw new Error("route decision requires a non-empty routeId");
    return [ctx.createArtifact({ id: `${this.spec.id}.decision`, type: ArtifactTypes.RouteDecision, value: decision, visibility: "runtime", leakage: "public" })];
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
      kind: OperatorKinds.Delegate,
      requiredInputTypes: [ArtifactTypes.Task],
      optionalInputTypes: [ArtifactTypes.RouteDecision],
      outputTypes: [ArtifactTypes.DelegationResult],
      sideEffects: options.sideEffects ?? "read_workspace"
    });
  }

  async run(inputs: readonly Artifact[], ctx: OperatorRunContext): Promise<readonly Artifact[]> {
    const route = inputs.find((artifact) => artifact.type === ArtifactTypes.RouteDecision)?.value as RouteDecision | undefined;
    if (route !== undefined && route.routeId.length === 0) throw new Error("route decision requires a non-empty routeId");
    const result = await this.#delegate({ task: taskFromInputs(inputs), route, ctx });
    if (result.role.length === 0) throw new Error("delegation result requires a non-empty role");
    return [ctx.createArtifact({ id: `${this.spec.id}.result`, type: ArtifactTypes.DelegationResult, value: result, visibility: "runtime", leakage: "public" })];
  }
}

export class ReviewOperator implements Operator {
  readonly spec: OperatorSpec;
  readonly #review: (input: { task: TaskSpec; inputs: readonly Artifact[]; ctx: OperatorRunContext }) => ReviewResult | Promise<ReviewResult>;

  constructor(options: { id?: string; review: (input: { task: TaskSpec; inputs: readonly Artifact[]; ctx: OperatorRunContext }) => ReviewResult | Promise<ReviewResult> }) {
    this.#review = options.review;
    this.spec = spec({ id: options.id ?? "review", kind: OperatorKinds.Review, requiredInputTypes: [ArtifactTypes.Task], outputTypes: [ArtifactTypes.Review] });
  }

  async run(inputs: readonly Artifact[], ctx: OperatorRunContext): Promise<readonly Artifact[]> {
    const review = await this.#review({ task: taskFromInputs(inputs), inputs, ctx });
    return [ctx.createArtifact({ id: `${this.spec.id}.review`, type: ArtifactTypes.Review, value: review, visibility: "developer", leakage: "public" })];
  }
}

export class TreeExpandOperator implements Operator {
  readonly spec: OperatorSpec;
  readonly #expand: (input: { task: TaskSpec; nodes: TreeNodeValue[]; ctx: OperatorRunContext }) => TreeNodeValue[] | Promise<TreeNodeValue[]>;

  constructor(options: { id?: string; expand: (input: { task: TaskSpec; nodes: TreeNodeValue[]; ctx: OperatorRunContext }) => TreeNodeValue[] | Promise<TreeNodeValue[]> }) {
    this.#expand = options.expand;
    this.spec = spec({ id: options.id ?? "tree.expand", kind: OperatorKinds.TreeExpand, requiredInputTypes: [ArtifactTypes.Task], optionalInputTypes: [ArtifactTypes.TreeNode], outputTypes: [ArtifactTypes.TreeNode] });
  }

  async run(inputs: readonly Artifact[], ctx: OperatorRunContext): Promise<readonly Artifact[]> {
    const nodes = inputs.filter((artifact) => artifact.type === ArtifactTypes.TreeNode).map((artifact) => artifact.value as TreeNodeValue);
    const expanded = await this.#expand({ task: taskFromInputs(inputs), nodes, ctx });
    for (const node of expanded) {
      if (node.nodeId.length === 0) throw new Error("tree node requires a non-empty nodeId");
      if (!Number.isInteger(node.depth) || node.depth < 0) throw new Error(`tree node ${node.nodeId} has invalid depth`);
    }
    return expanded.map((node) => ctx.createArtifact({ id: `${this.spec.id}.${node.nodeId}`, type: ArtifactTypes.TreeNode, value: node, visibility: "runtime", leakage: "public" }));
  }
}

export class TreeScoreOperator implements Operator {
  readonly spec: OperatorSpec;
  readonly #score: (input: { nodes: TreeNodeValue[]; ctx: OperatorRunContext }) => RankMatrix | Promise<RankMatrix>;

  constructor(options: { id?: string; score: (input: { nodes: TreeNodeValue[]; ctx: OperatorRunContext }) => RankMatrix | Promise<RankMatrix> }) {
    this.#score = options.score;
    this.spec = spec({ id: options.id ?? "tree.score", kind: OperatorKinds.TreeScore, requiredInputTypes: [ArtifactTypes.TreeNode], outputTypes: [ArtifactTypes.RankMatrix] });
  }

  async run(inputs: readonly Artifact[], ctx: OperatorRunContext): Promise<readonly Artifact[]> {
    const matrix = await this.#score({
      nodes: inputs.filter((artifact) => artifact.type === ArtifactTypes.TreeNode).map((artifact) => artifact.value as TreeNodeValue),
      ctx
    });
    validateRankMatrix(matrix);
    return [ctx.createArtifact({ id: `${this.spec.id}.matrix`, type: ArtifactTypes.RankMatrix, value: matrix, visibility: "runtime", leakage: "public" })];
  }
}

export class ArchitectureEvaluateOperator implements Operator {
  readonly spec: OperatorSpec;
  readonly #evaluate: (input: { task: TaskSpec; ctx: OperatorRunContext }) => ArchitectureEvaluation | Promise<ArchitectureEvaluation>;

  constructor(options: { id?: string; evaluate: (input: { task: TaskSpec; ctx: OperatorRunContext }) => ArchitectureEvaluation | Promise<ArchitectureEvaluation> }) {
    this.#evaluate = options.evaluate;
    this.spec = spec({ id: options.id ?? "architecture.evaluate", kind: OperatorKinds.ArchitectureEvaluate, requiredInputTypes: [ArtifactTypes.Task], outputTypes: [ArtifactTypes.ArchitectureResult] });
  }

  async run(inputs: readonly Artifact[], ctx: OperatorRunContext): Promise<readonly Artifact[]> {
    const result = await this.#evaluate({ task: taskFromInputs(inputs), ctx });
    if (result.architectureId.length === 0) throw new Error("architecture evaluation requires a non-empty architectureId");
    assertScore(`architecture ${result.architectureId}`, result.score);
    return [ctx.createArtifact({ id: `${this.spec.id}.result`, type: ArtifactTypes.ArchitectureResult, value: result, visibility: "developer", leakage: "private" })];
  }
}

export class OfflineModelMergeOperator implements Operator {
  readonly spec: OperatorSpec;
  readonly #merge: (input: { task: TaskSpec; ctx: OperatorRunContext }) => MergeRecipe | Promise<MergeRecipe>;

  constructor(options: { id?: string; merge: (input: { task: TaskSpec; ctx: OperatorRunContext }) => MergeRecipe | Promise<MergeRecipe> }) {
    this.#merge = options.merge;
    this.spec = spec({ id: options.id ?? "model.merge.recipe", kind: OperatorKinds.ModelMerge, requiredInputTypes: [ArtifactTypes.Task], outputTypes: [ArtifactTypes.MergeRecipe] });
  }

  async run(inputs: readonly Artifact[], ctx: OperatorRunContext): Promise<readonly Artifact[]> {
    const recipe = await this.#merge({ task: taskFromInputs(inputs), ctx });
    if (recipe.recipeId.length === 0) throw new Error("merge recipe requires a non-empty recipeId");
    if (recipe.modelIds.length === 0) throw new Error(`merge recipe ${recipe.recipeId} requires at least one model`);
    if (recipe.steps.length === 0) throw new Error(`merge recipe ${recipe.recipeId} requires at least one step`);
    return [ctx.createArtifact({ id: `${this.spec.id}.${recipe.recipeId}`, type: ArtifactTypes.MergeRecipe, value: recipe, visibility: "developer", leakage: "private" })];
  }
}
