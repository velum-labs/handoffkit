# FusionKit runtime kernel

FusionKit's TypeScript runtime kernel executes typed operator graphs under explicit schedulers.
It is the programmatic composition layer for model-fusion workflows. The runtime is deliberately
boring: it stores immutable artifacts, runs operators, enforces budgets and side-effect policy,
records trace/provenance, and emits replayable outcomes. Behavior lives in schedulers and operator
policies, not in a monolithic MoA controller.

## Mental model

```text
TaskSpec
  -> typed artifacts
  -> operators
  -> OperatorGraph / workflow recipe
  -> scheduler family
  -> evidence / observations / signals
  -> budget / trace / OutcomeRecord / replay
```

Use the kernel when composing or testing:

- direct single-model calls;
- OpenRouter-style `panel -> judge -> synth`;
- LLM-Blender-style `rank -> select -> fuse`;
- evidence-guided selection/repair;
- agentic delegation with single-writer budgets;
- tree-search or learned policy schedulers;
- offline architecture evaluation or model-merge recipe lifecycles.

Do not use the kernel as a learned-policy training loop. Learned coordination consumes replay and
outcome records emitted by the kernel; it does not live inside the runtime substrate.

Advanced scheduler-family classes are extension points unless stated otherwise.
For example, `TreeSearchScheduler` validates and executes graph nodes that
represent expansion/scoring, but it is not a full AB-MCTS/TreeQuest search loop
until a concrete search-state policy is supplied around it.

## Install / import surface

The dependency-free runtime substrate lives in `@fusionkit/kernel`
(`packages/kernel`); `@fusionkit/ensemble` re-exports it
(`packages/ensemble/src/runtime.ts`) and owns the operators, workflow recipes,
and schedulers on top. The imports below go through ensemble and work as shown.

```ts
import { FusionRuntime } from "@fusionkit/ensemble/runtime";
import { graph, refs } from "@fusionkit/ensemble/kernel";
import { RankFuseScheduler } from "@fusionkit/ensemble/schedulers";
import { EvidenceSourceOperator } from "@fusionkit/ensemble/operators/evidence";
import { rankFuseWorkflow } from "@fusionkit/ensemble/workflows";
```

The root package still exports the same APIs for convenience:

```ts
import { graph, refs, RankFuseScheduler } from "@fusionkit/ensemble";
```

## Quick example: direct fast path

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

This path runs exactly one `model.generate` operator. It does not run a panel, judge, synthesizer,
ranker, verifier, or evidence source.

## Explicit graph composition

Prefer the graph builder for application code:

```ts
const workflow = graph("panel-judge-synth")
  .task(task)
  .node("panel", panelOperator, {
    inputs: [refs.artifact(task.id)]
  })
  .node("judge", judgeOperator, {
    inputs: [refs.artifact(task.id), refs.node("panel", ArtifactTypes.Candidate)]
  })
  .node("synth", synthOperator, {
    inputs: [
      refs.artifact(task.id),
      refs.node("panel", ArtifactTypes.Candidate),
      refs.node("judge", ArtifactTypes.JudgeComparison)
    ]
  })
  .scheduler(new StaticDAGScheduler())
  .budget({ maxCandidates: 3, maxWorkspaceWriters: 1 })
  .compile();
```

The builder compiles to the same `OperatorGraph` object the runtime executes. It exists for DX; it
does not bypass graph validation or runtime invariants.

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

Register them when you want workflow IDs:

```ts
import { getWorkflow, listWorkflows, registerBuiltInWorkflows } from "@fusionkit/ensemble";

registerBuiltInWorkflows();
console.log(listWorkflows());
console.log(getWorkflow("rank-fuse"));
```

## Type and graph helpers

Use:

- `ArtifactTypes` and `OperatorKinds` instead of raw strings;
- `refs.artifact(id)` and `refs.node(nodeId, type)` instead of raw input ref objects;
- `validateOperatorGraph`, `validateSchedulerGraph`, and `explainGraph` for preflight checks;
- `createRuntimeReplayRecord` for replayable outcome data.

## Runtime invariants

- Artifacts are immutable and typed.
- Operators consume artifact IDs and emit artifact IDs.
- Operators declare side effects.
- Schedulers choose execution order; operators do not choose global control flow.
- Private/contaminated evidence is recorded in outcomes but hidden from scheduler-visible state.
- Private eval artifacts cannot enter runtime operator inputs by default.
- Selection requires ranking, comparison, or an explicit selector policy.
- Learned workflow policies must choose a currently ready node.
- Budget reservations happen before awaited work so concurrent DAG execution cannot oversubscribe.
- Every run can emit an `OutcomeRecord` and `fusion-runtime-replay.v1` replay record.

## Failure handling

By default, failed runtime execution throws `RuntimeExecutionError`. The error carries:

- `outcome`
- `trace`
- `artifacts`
- `observations`
- `signals`
- `cause`

Use `failureMode: "return"` when callers need a normal `RuntimeExecutionResult` for failed runs:

```ts
const result = await runtime.run({
  graph,
  scheduler,
  artifacts,
  failureMode: "return"
});

if (result.outcome.status === "failed") {
  console.log(result.outcome.error);
}
```

## Budget accounting

Operators can declare `expectedCost` and can record actual usage with `ctx.consumeBudget(...)`.

Budget policy supports:

- `maxOperatorRuns`
- `maxArtifacts`
- `maxCandidates`
- `maxCostUsd`
- `maxInputTokens`
- `maxOutputTokens`
- `maxLatencyMs`
- `maxToolCalls`
- `maxWorkspaceWriters`
- `allowedSideEffects`
- `expectedCostPolicy: "reserve" | "advisory"`

Use `"reserve"` for production caps where expected resource use should be reserved before operator
work starts. Use `"advisory"` when only observed usage should count.

## Evidence and leakage

Evidence is not success. Operators can record:

- `Observation`: raw evidence from tests, validators, tools, judges, rankers, etc.
- `Signal`: calibrated score/confidence for a target artifact.

Signals carry `leakageRisk`. Public signals may guide runtime scheduling. Private signals are
recorded in outcomes for evaluation and replay but are hidden from scheduler-visible state.

## Production integration status

The production gateway path currently uses the runtime kernel for panel capture. The live
`trajectories:fuse` synthesis step still runs through the gateway/Python synthesizer path. The
workflow registry is the migration seam for moving richer panel/judge/synth and rank/fuse flows
behind explicit workflow IDs without changing gateway behavior unexpectedly.

## Runnable demo

```bash
pnpm build
pnpm demo 15
```

The demo composes:

1. direct fast path;
2. rank/fuse panel workflow;
3. replay export.

See `examples/runtime-kernel/src/run.ts`.

## Product cutover

This guide describes the runtime substrate and composition API. The fusion
front-door turn (`fusionkit codex / claude / cursor / serve`) is kernel-native:
every request runs as a `fusion-frontdoor-request` graph that routes into the
`fusion-frontdoor-turn` graph of operators. Other surfaces (local/MLX/Codex leaf backends, `runEnsemble`, and
the Python routes) still enter the kernel through compatibility wrappers. For the
full migration plan, streaming/session-state requirements, and surface parity
checklist, see `docs/fusion/kernel-migration.md`.
