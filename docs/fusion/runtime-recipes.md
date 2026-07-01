# FusionKit runtime recipes

These recipes show how to compose common FusionKit kernels with the TypeScript composition API.
They mirror the tested paths in `packages/ensemble/src/test/runtime.test.ts`.

## Imports

```ts
import {
  ArtifactTypes,
  DirectFastPathScheduler,
  ModelGenerateOperator,
  PanelGenerateOperator,
  JudgeCompareOperator,
  SynthesizeOperator,
  PairRankOperator,
  SelectOperator,
  GenFuserOperator,
  StaticDAGScheduler,
  RankFuseScheduler,
  createTaskArtifact,
  graph,
  refs
} from "@fusionkit/ensemble";
```

## Direct model call

Use for degree-1, latency-sensitive requests.

```ts
const task = createTaskArtifact({ id: "task", prompt: "Answer directly." });

const workflow = graph("direct")
  .task(task)
  .node("model", new ModelGenerateOperator({
    model: "fast-model",
    client: { generate: ({ prompt }) => ({ model: "fast-model", content: prompt }) }
  }), { inputs: [refs.artifact(task.id)] })
  .scheduler(new DirectFastPathScheduler())
  .compile();

const result = await workflow.run();
```

Invariant: this path does no hidden fanout, judging, synthesis, verification, or repair.

## Panel -> judge -> synth

Use for OpenRouter-style fusion.

```ts
const workflow = graph("panel-judge-synth")
  .task(task)
  .node("panel", new PanelGenerateOperator({ models, runner: panelRunner }), {
    inputs: [refs.artifact(task.id)]
  })
  .node("judge", new JudgeCompareOperator({ compare: judgeCompare }), {
    inputs: [refs.artifact(task.id), refs.node("panel", ArtifactTypes.Candidate)]
  })
  .node("synth", new SynthesizeOperator({ synthesize }), {
    inputs: [
      refs.artifact(task.id),
      refs.node("panel", ArtifactTypes.Candidate),
      refs.node("judge", ArtifactTypes.JudgeComparison)
    ]
  })
  .scheduler(new StaticDAGScheduler())
  .budget({ maxCandidates: models.length })
  .compile();
```

## Rank -> select -> fuse

Use for LLM-Blender-style workflows.

```ts
const workflow = graph("rank-fuse")
  .task(task)
  .node("panel", new PanelGenerateOperator({ models, runner: panelRunner }), {
    inputs: [refs.artifact(task.id)]
  })
  .node("rank", new PairRankOperator({ rank }), {
    inputs: [refs.artifact(task.id), refs.node("panel", ArtifactTypes.Candidate)]
  })
  .node("select", new SelectOperator(), {
    inputs: [
      refs.artifact(task.id),
      refs.node("panel", ArtifactTypes.Candidate),
      refs.node("rank", ArtifactTypes.RankMatrix)
    ]
  })
  .node("fuse", new GenFuserOperator({ fuse }), {
    inputs: [
      refs.artifact(task.id),
      refs.node("panel", ArtifactTypes.Candidate),
      refs.node("rank", ArtifactTypes.RankMatrix),
      refs.node("select", ArtifactTypes.SelectedCandidate)
    ]
  })
  .scheduler(new RankFuseScheduler())
  .compile();
```

Selection fails closed unless a rank matrix, judge comparison, or explicit selector policy is present.

## Evidence-guided select/repair

Use public evidence at runtime and keep private grading out of scheduler state.

```ts
const workflow = executionSelectRepairWorkflow({
  task,
  models,
  panel: panelRunner,
  evidence: publicTestEvidence,
  selector: selectFromEvidence,
  repair: repairCandidate,
  budget: { maxCandidates: models.length + 1, maxWorkspaceWriters: 1 }
});
```

The evidence source returns observations/signals. Public signals can guide selection. Private labels
should be recorded only after the run for evaluation.

## Agentic delegation

Use route/delegate/review operators with single-writer budget caps.

```ts
const workflow = graph("agentic")
  .task(task)
  .node("route", routeOperator, { inputs: [refs.artifact(task.id)] })
  .node("sidekick", delegateOperator, {
    inputs: [refs.artifact(task.id), refs.node("route", ArtifactTypes.RouteDecision)]
  })
  .scheduler(new AgenticDelegationScheduler())
  .budget({ maxWorkspaceWriters: 1 })
  .compile();
```

The budget, not prompt labels, enforces writer discipline.

## Failure/replay

```ts
const result = await workflow.run({ runId: "example" });
const replay = createRuntimeReplayRecord(result);
```

For failed runs:

```ts
const result = await runtime.run({ graph, scheduler, artifacts, failureMode: "return" });
```

or catch `RuntimeExecutionError` and inspect `error.outcome`.
