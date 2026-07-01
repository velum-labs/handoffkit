# FusionKit runtime kernel implementation status

This document tracks the implementation status of the architecture in `docs/fusion/MOA_DESIGN.md`.

## Done in the TypeScript kernel

### Runtime substrate

- `Artifact`
- `TaskSpec`
- `OperatorSpec`
- `Operator`
- `OperatorGraph`
- `Scheduler`
- `BudgetPolicy`
- `TraceEvent`
- `Observation`
- `Signal`
- `OutcomeRecord`
- `fusion-runtime-replay.v1` replay records
- `RuntimeEvent` streaming contract and `FusionRuntime.stream(...)`
- `KernelSessionState`, `KernelTurnState`, and `KernelStateStore`

### Runtime invariants

- Immutable typed artifacts.
- Artifact lineage and trace events.
- Side-effect policy and single-writer enforcement.
- Budget caps for runs, artifacts, candidates, cost, tokens, tool calls, latency, and workspace writers.
- Retry and cancellation classification.
- Private/contaminated evidence hidden from scheduler-visible state.
- Private eval artifacts blocked from runtime operator inputs by default.
- Failed runs expose outcome/trace/artifacts through `RuntimeExecutionError` or `failureMode: "return"`.

### Scheduler families

- `DirectFastPathScheduler`
- `StaticDAGScheduler`
- `FixedLayerMoAScheduler`
- `BestOfNScheduler`
- `RankFuseScheduler`
- `ExecutionSelectRepairScheduler`
- `AdaptiveRouterScheduler`
- `TreeSearchScheduler`
- `AgenticDelegationScheduler`
- `LearnedWorkflowScheduler`
- `OfflineArchitectureSearchScheduler`

### Operators

- model generation
- panel generation
- judge comparison
- synthesis
- evidence source
- signal calibration
- schema validation
- pair ranking
- selection
- repair
- GenFuser-style fusion
- route/delegate/review
- tree expand/score
- architecture evaluation
- offline model-merge recipe

### Developer experience

- artifact/operator constants
- graph refs and topology utilities
- graph validation and explanation
- fluent `GraphBuilder`
- workflow registry
- built-in workflow recipes
- legacy compatibility workflows for `ensemble-run` and Python `trajectories:fuse`
- `runEnsemble` public API wrapped through a kernel compatibility graph
- CLI local/fusion gateways wrapped through `KernelBackend`
- package subpath exports
- `fusionkit runtime list`
- `fusionkit runtime explain <workflow>`
- package README and runtime docs
- runnable `pnpm demo 15`

## Partially integrated

- Production `runFusionPanels` uses the runtime kernel for panel capture.
- `runFusionPanelWorkflow` exposes the runtime result for callers needing traces/outcomes/replay.
- Product Node backends for local and fusion-step gateways enter the kernel through
  compatibility backend operators while preserving legacy behavior.
- Python server routes enter a Python `FusionKernel` compatibility wrapper around
  `FusionEngine` and `FusionRunManager`.
- Live gateway synthesis still posts to `trajectories:fuse` through the gateway/Python synthesizer path.

## Not embedded in the kernel by design

- learned-policy training;
- off-policy optimization;
- provider-specific telemetry ingestion across every adapter;
- arbitrary JSON graph execution with function operators.

Those consume the runtime's replay/outcome records or require an application-provided operator
registry.

## Main migration seam

The workflow registry is the migration seam for moving richer production flows behind explicit
workflow IDs without changing the existing gateway behavior unexpectedly.

See `docs/fusion/kernel-migration.md` for the product cutover plan, required streaming runtime,
session-state model, and parity checklist.
