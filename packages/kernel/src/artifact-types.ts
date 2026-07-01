export const ArtifactTypes = {
  ArchitectureResult: "architecture_result",
  Candidate: "candidate",
  DelegationResult: "delegation_result",
  EvidenceBundle: "evidence_bundle",
  FinalAnswer: "final_answer",
  JudgeComparison: "judge_comparison",
  MergeRecipe: "merge_recipe",
  PrivateGrade: "private_grade",
  RankMatrix: "rank_matrix",
  Review: "review",
  RouteDecision: "route_decision",
  SelectedCandidate: "selected_candidate",
  Task: "task",
  TreeNode: "tree_node"
} as const;

export type ArtifactType = (typeof ArtifactTypes)[keyof typeof ArtifactTypes] | (string & {});

export const OperatorKinds = {
  ArchitectureEvaluate: "architecture.evaluate",
  Calibrate: "calibrate",
  Delegate: "delegate",
  Evidence: "evidence",
  Fuse: "fuse",
  JudgeCompare: "judge.compare",
  ModelGenerate: "model.generate",
  ModelMerge: "model.merge",
  PanelGenerate: "panel.generate",
  Rank: "rank",
  Repair: "repair",
  Review: "review",
  Route: "route",
  Select: "select",
  Synthesize: "synthesize",
  TreeExpand: "tree.expand",
  TreeScore: "tree.score"
} as const;

export type OperatorKind = (typeof OperatorKinds)[keyof typeof OperatorKinds] | (string & {});
