import { ArtifactTypes } from "./artifact-types.js";
import {
  EvidenceSourceOperator,
  GenFuserOperator,
  PairRankOperator,
  RepairOperator,
  SelectOperator
} from "./advanced-operators.js";
import {
  JudgeCompareOperator,
  ModelGenerateOperator,
  PanelGenerateOperator,
  SynthesizeOperator
} from "./fusion-operators.js";
import { graph, registerWorkflow, refs } from "./kernel.js";
import { createTaskArtifact } from "./kernel-helpers.js";
import {
  DirectFastPathScheduler,
  StaticDAGScheduler
} from "./runtime.js";
import {
  ExecutionSelectRepairScheduler,
  RankFuseScheduler
} from "./schedulers.js";
import type {
  CandidateRepairer,
  CandidateSelector,
  EvidenceSource,
  RankMatrix,
  RepairPredicate
} from "./advanced-operators.js";
import type {
  CandidateArtifactValue,
  JudgeComparator,
  ModelClient,
  PanelRunner,
  Synthesizer
} from "./fusion-operators.js";
import type { EnsembleModel } from "./harness.js";
import type { BudgetPolicy, Scheduler, TaskSpec } from "./runtime.js";
import type { KernelWorkflow, WorkflowFactory } from "./kernel.js";

export type DirectModelWorkflowInput = {
  task: TaskSpec;
  model: string;
  modelId?: string;
  client: ModelClient;
  budget?: BudgetPolicy;
};

export function directModelWorkflow(input: DirectModelWorkflowInput): KernelWorkflow {
  const task = createTaskArtifact({ ...input.task, artifactId: input.task.id ?? "task" });
  return graph("direct-model")
    .task(task)
    .node("model", new ModelGenerateOperator({
      model: input.model,
      ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
      client: input.client
    }), { inputs: [refs.artifact(task.id)] })
    .scheduler(new DirectFastPathScheduler())
    .budget(input.budget ?? {})
    .compile();
}

export type PanelCaptureWorkflowInput = {
  task: TaskSpec;
  models: readonly EnsembleModel[];
  runner: PanelRunner;
  scheduler?: Scheduler;
  budget?: BudgetPolicy;
};

export function panelCaptureWorkflow(input: PanelCaptureWorkflowInput): KernelWorkflow {
  const task = createTaskArtifact({ ...input.task, artifactId: input.task.id ?? "task" });
  return graph("panel-capture")
    .task(task)
    .node("panel", new PanelGenerateOperator({
      models: input.models,
      runner: input.runner
    }), { inputs: [refs.artifact(task.id)] })
    .scheduler(input.scheduler ?? new StaticDAGScheduler())
    .budget(input.budget ?? { maxCandidates: input.models.length })
    .compile();
}

export type PanelJudgeSynthWorkflowInput = {
  task: TaskSpec;
  models: readonly EnsembleModel[];
  panel: PanelRunner;
  judge: JudgeComparator;
  synthesize: Synthesizer;
  budget?: BudgetPolicy;
};

export function panelJudgeSynthWorkflow(input: PanelJudgeSynthWorkflowInput): KernelWorkflow {
  const task = createTaskArtifact({ ...input.task, artifactId: input.task.id ?? "task" });
  return graph("panel-judge-synth")
    .task(task)
    .node("panel", new PanelGenerateOperator({ models: input.models, runner: input.panel }), { inputs: [refs.artifact(task.id)] })
    .node("judge", new JudgeCompareOperator({ compare: input.judge }), {
      inputs: [refs.artifact(task.id), refs.node("panel", ArtifactTypes.Candidate)]
    })
    .node("synth", new SynthesizeOperator({ synthesize: input.synthesize }), {
      inputs: [
        refs.artifact(task.id),
        refs.node("panel", ArtifactTypes.Candidate),
        refs.node("judge", ArtifactTypes.JudgeComparison)
      ]
    })
    .scheduler(new StaticDAGScheduler())
    .budget(input.budget ?? { maxCandidates: input.models.length })
    .compile();
}

export type RankFuseWorkflowInput = {
  task: TaskSpec;
  models: readonly EnsembleModel[];
  panel: PanelRunner;
  rank: (input: { candidates: CandidateArtifactValue[]; task: TaskSpec }) => RankMatrix | Promise<RankMatrix>;
  fuse: ConstructorParameters<typeof GenFuserOperator>[0]["fuse"];
  selector?: CandidateSelector;
  budget?: BudgetPolicy;
};

export function rankFuseWorkflow(input: RankFuseWorkflowInput): KernelWorkflow {
  const task = createTaskArtifact({ ...input.task, artifactId: input.task.id ?? "task" });
  return graph("rank-fuse")
    .task(task)
    .node("panel", new PanelGenerateOperator({ models: input.models, runner: input.panel }), { inputs: [refs.artifact(task.id)] })
    .node("rank", new PairRankOperator({
      rank: ({ candidates, task: taskSpec }) => input.rank({ candidates, task: taskSpec })
    }), { inputs: [refs.artifact(task.id), refs.node("panel", ArtifactTypes.Candidate)] })
    .node("select", new SelectOperator({ ...(input.selector !== undefined ? { selector: input.selector } : {}) }), {
      inputs: [refs.artifact(task.id), refs.node("panel", ArtifactTypes.Candidate), refs.node("rank", ArtifactTypes.RankMatrix)]
    })
    .node("fuse", new GenFuserOperator({ fuse: input.fuse }), {
      inputs: [
        refs.artifact(task.id),
        refs.node("panel", ArtifactTypes.Candidate),
        refs.node("rank", ArtifactTypes.RankMatrix),
        refs.node("select", ArtifactTypes.SelectedCandidate)
      ]
    })
    .scheduler(new RankFuseScheduler())
    .budget(input.budget ?? { maxCandidates: input.models.length })
    .compile();
}

export type ExecutionSelectRepairWorkflowInput = {
  task: TaskSpec;
  models: readonly EnsembleModel[];
  panel: PanelRunner;
  evidence: EvidenceSource;
  selector: CandidateSelector;
  repairWhen: RepairPredicate;
  repair: CandidateRepairer;
  budget?: BudgetPolicy;
};

export type ExecutionSelectWorkflowInput = {
  task: TaskSpec;
  models: readonly EnsembleModel[];
  panel: PanelRunner;
  evidence: EvidenceSource;
  selector: CandidateSelector;
  budget?: BudgetPolicy;
};

export function executionSelectWorkflow(input: ExecutionSelectWorkflowInput): KernelWorkflow {
  const task = createTaskArtifact({ ...input.task, artifactId: input.task.id ?? "task" });
  return graph("execution-select")
    .task(task)
    .node("panel", new PanelGenerateOperator({ models: input.models, runner: input.panel }), { inputs: [refs.artifact(task.id)] })
    .node("evidence", new EvidenceSourceOperator({ source: input.evidence }), {
      inputs: [refs.artifact(task.id), refs.node("panel", ArtifactTypes.Candidate)]
    })
    .node("select", new SelectOperator({ selector: input.selector }), {
      inputs: [
        refs.artifact(task.id),
        refs.node("panel", ArtifactTypes.Candidate),
        refs.node("evidence", ArtifactTypes.EvidenceBundle)
      ]
    })
    .scheduler(new ExecutionSelectRepairScheduler({ maxRepairRounds: 0 }))
    .budget(input.budget ?? { maxCandidates: input.models.length })
    .compile();
}

export function executionSelectRepairWorkflow(input: ExecutionSelectRepairWorkflowInput): KernelWorkflow {
  const task = createTaskArtifact({ ...input.task, artifactId: input.task.id ?? "task" });
  return graph("execution-select-repair")
    .task(task)
    .node("panel", new PanelGenerateOperator({ models: input.models, runner: input.panel }), { inputs: [refs.artifact(task.id)] })
    .node("evidence", new EvidenceSourceOperator({ source: input.evidence }), {
      inputs: [refs.artifact(task.id), refs.node("panel", ArtifactTypes.Candidate)]
    })
    .node("select", new SelectOperator({ selector: input.selector }), {
      inputs: [
        refs.artifact(task.id),
        refs.node("panel", ArtifactTypes.Candidate),
        refs.node("evidence", ArtifactTypes.EvidenceBundle)
      ]
    })
    .node("repair", new RepairOperator({ repair: input.repair, shouldRepair: input.repairWhen }), {
      inputs: [
        refs.artifact(task.id),
        refs.node("panel", ArtifactTypes.Candidate),
        refs.node("evidence", ArtifactTypes.EvidenceBundle),
        refs.node("select", ArtifactTypes.SelectedCandidate)
      ]
    })
    .scheduler(new ExecutionSelectRepairScheduler({ maxRepairRounds: 1 }))
    .budget(input.budget ?? { maxCandidates: input.models.length + 1 })
    .compile();
}

export function registerBuiltInWorkflows(): void {
  const workflows: Array<[string, WorkflowFactory]> = [
    ["direct", directModelWorkflow],
    ["panel-capture", panelCaptureWorkflow],
    ["panel-judge-synth", panelJudgeSynthWorkflow],
    ["rank-fuse", rankFuseWorkflow],
    ["execution-select", executionSelectWorkflow],
    ["execution-select-repair", executionSelectRepairWorkflow]
  ];
  for (const [id, factory] of workflows) {
    try {
      registerWorkflow(id, factory);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("already registered")) throw error;
    }
  }
}
