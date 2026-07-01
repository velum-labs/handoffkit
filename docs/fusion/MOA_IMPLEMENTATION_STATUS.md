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

- The fusion front-door gateway turn is kernel-native: `FusionBackend` dispatches each turn as a
  `fusion-frontdoor-turn` / `fusion-passthrough-turn` runtime graph (see Known limitations).
- Production `runFusionPanels` uses the runtime kernel for panel capture.
- `runFusionPanelWorkflow` exposes the runtime result for callers needing traces/outcomes/replay.
- Local direct and MLX/Codex harness leaf gateways enter the kernel through the `KernelBackend`
  compatibility wrapper (those backends are not yet kernel-native).
- Python server routes enter a Python `FusionKernel` compatibility wrapper around
  `FusionEngine` and `FusionRunManager`.
- Live gateway synthesis runs the `trajectories:fuse` step through the shared kernel fuse-step
  operator (`createKernelFuseStepRunner`); the Python service remains the synthesis implementation.

## Not embedded in the kernel by design

- learned-policy training;
- off-policy optimization;
- provider-specific telemetry ingestion across every adapter;
- arbitrary JSON graph execution with function operators.

Those consume the runtime's replay/outcome records or require an application-provided operator
registry.

## Known limitations

- `KernelBackend` and the kernel fuse-step runner now emit a typed `wire_response` artifact
  (status, headers, content type, streaming flag, and a buffered body for non-streaming replies) via
  `captureWireResponse`, alongside the live `Response` handed back to the caller. Non-streaming
  replies are therefore replay-clean; live streaming (`text/event-stream`) responses are passed
  through untouched and captured only at the envelope level, which is inherent to a live stream.
- Advanced scheduler families (adaptive router, tree search, agentic delegation, learned workflow)
  are Phase 1 scaffolds: they validate and execute static graphs and provide the plug-in seam for
  real adaptive control; they do not yet implement AB-MCTS/TreeQuest-style wider/deeper search,
  Devin-style routing, or learned coordination.
- `FusionRuntime.stream(...)` is a real graph-level streaming engine: it runs the graph once and
  forwards every streaming operator's live events (`output.delta`, `tool_call.delta`, `sse.chunk`,
  `keepalive`, trace), then a terminal `final`/`error`.
- The fusion front-door request and turn are now natively composed from kernel operators. The
  runtime substrate was extracted into the standalone `@fusionkit/kernel` package to invert the
  `model-gateway` -> `ensemble` dependency, so `FusionBackend` dispatches every request as a named
  runtime graph. `fusion-frontdoor-request` makes the budget gate (`frontdoor.budget-gate`) and
  requested-model resolution (`frontdoor.resolve-model`) first-class operators, and
  `FrontdoorRequestScheduler` routes to budget-stop, the fused turn, or the passthrough turn. The
  fused turn is `fusion-frontdoor-turn` (`frontdoor.panel -> frontdoor.fuse -> frontdoor.finalize`
  buffered, or `frontdoor.panel -> frontdoor.fuse.stream` streamed via `eventsToSseResponse`); the
  vendor branch is `fusion-passthrough-turn` (`frontdoor.passthrough`, whose rate-limit failover
  re-enters the fusion turn). The redundant outer `KernelBackend` wrapper around the fusion gateway
  was removed; `FusionBackend` is a kernel-native surface adapter. The panel/fuse/proxy operators
  intentionally delegate their side-effecting wire to injected implementations (the operator
  pattern, e.g. `ModelGenerateOperator` wrapping a `ModelClient`); the vendor-proxy SSE peeking for
  mid-stream resume notices is the passthrough operator's transport implementation.

## Main migration seam

The workflow registry is the migration seam for moving richer production flows behind explicit
workflow IDs without changing the existing gateway behavior unexpectedly.

See `docs/fusion/kernel-migration.md` for the product cutover plan, required streaming runtime,
session-state model, and parity checklist.
