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

## Known limitations

- `KernelBackend` is a compatibility adapter: it wraps each gateway call as a one-node static-DAG
  graph whose output artifact value is the raw `Response` object returned by the legacy backend.
  This is enough for the "all product surfaces enter the kernel" boundary and for admission /
  provenance / budget accounting, but a `Response` is **not** a replay-clean semantic wire artifact
  (e.g. "OpenAI SSE stream", "final text", "usage", "tool-call delta"). Producing typed wire
  artifacts for gateway surfaces is tracked as follow-up (see `kernel-migration.md`, Phase 2) and is
  a prerequisite before claiming product-grade replay/outcome data for the gateway path.
- Advanced scheduler families (adaptive router, tree search, agentic delegation, learned workflow)
  are Phase 1 scaffolds: they validate and execute static graphs and provide the plug-in seam for
  real adaptive control; they do not yet implement AB-MCTS/TreeQuest-style wider/deeper search,
  Devin-style routing, or learned coordination.
- `FusionRuntime.stream(...)` emits a single terminal event for workflows whose operators do not
  implement `stream`; product streaming (direct/tool-call deltas, keepalives, fuse-step SSE) still
  lives in `FusionBackend` until streaming operators are wired through the gateway path.

## Main migration seam

The workflow registry is the migration seam for moving richer production flows behind explicit
workflow IDs without changing the existing gateway behavior unexpectedly.

See `docs/fusion/kernel-migration.md` for the product cutover plan, required streaming runtime,
session-state model, and parity checklist.
