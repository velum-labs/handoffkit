# FusionKit runtime kernel

FusionKit's TypeScript runtime kernel executes typed operator graphs under explicit schedulers.
It is the programmatic composition layer for model-fusion workflows.

## Core loop

```text
TaskSpec -> Artifact contracts -> Operators -> OperatorGraph -> Scheduler -> OutcomeRecord
```

Use the kernel when you want to compose or test workflows such as:

- direct single-model calls;
- panel -> judge -> synth;
- rank -> select -> fuse;
- evidence-guided select/repair;
- agentic delegation with single-writer budgets;
- tree-search or learned policy schedulers.

## Quick example

```ts
import {
  DirectFastPathScheduler,
  ModelGenerateOperator,
  createTaskArtifact,
  graph,
  refs
} from "@fusionkit/ensemble";

const task = createTaskArtifact({ id: "task", prompt: "Say hi." });

const workflow = graph("direct")
  .task(task)
  .node("model", new ModelGenerateOperator({
    model: "demo",
    client: { generate: () => ({ model: "demo", content: "hi" }) }
  }), { inputs: [refs.artifact(task.id)] })
  .scheduler(new DirectFastPathScheduler())
  .compile();

const result = await workflow.run();
```

## Built-in workflow recipes

`@fusionkit/ensemble/workflows` exports:

- `directModelWorkflow`
- `panelCaptureWorkflow`
- `panelJudgeSynthWorkflow`
- `rankFuseWorkflow`
- `executionSelectRepairWorkflow`
- `registerBuiltInWorkflows`

These recipes compile explicit operators and schedulers into `OperatorGraph`s. They do not infer
hidden fanout or silently choose candidates.

## CLI discovery

```bash
fusionkit runtime list
fusionkit runtime explain panel-judge-synth
```

## Type and graph helpers

Use:

- `ArtifactTypes` and `OperatorKinds` instead of raw strings;
- `refs.artifact(id)` and `refs.node(nodeId, type)` instead of raw input ref objects;
- `validateOperatorGraph`, `validateSchedulerGraph`, and `explainGraph` for preflight checks;
- `createRuntimeReplayRecord` for replayable outcome data.

## Production integration status

The production gateway path currently uses the runtime kernel for panel capture. The live
`trajectories:fuse` synthesis step still runs through the gateway/Python synthesizer path. The
workflow registry is the migration seam for moving richer panel/judge/synth and rank/fuse flows
behind explicit workflow IDs without changing gateway behavior unexpectedly.
