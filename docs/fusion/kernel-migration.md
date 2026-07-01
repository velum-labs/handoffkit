# FusionKit kernel migration and cutover plan

Status: product cutover plan for the runtime kernel introduced in PR #37.

PR #37 makes the kernel real, but it does **not** make every product execution
surface decomposed into native kernel operators. The current production path is
now kernel-wrapped for the Node/CLI surfaces, while preserving conservative
legacy behavior inside compatibility operators:

```text
fusionkit codex / claude / cursor / serve
  -> CLI launcher
  -> startFusionStack
  -> startFusionStepGateway
  -> KernelBackend
  -> legacy FusionBackend.chat operator
  -> runFusionPanels
  -> runtime kernel for panel capture only
  -> runEnsemble kernel wrapper
  -> legacy runEnsemble implementation operator
  -> Python trajectories:fuse inside legacy backend turn
  -> gateway streaming back to the tool
```

This is intentional for the substrate PR. The target architecture is one
canonical execution plane:

```text
Surface adapter
  -> request/task adapter
  -> workflow registry
  -> FusionRuntime / StreamingFusionRuntime
  -> operators
  -> stores: artifact, session, trace, outcome
  -> response adapter
```

Surface adapters may own CLI flags, protocol dialects, auth headers, process
launch, and HTTP route shape. They must not own fusion decisions such as direct
vs panel, native passthrough, failover, candidate generation, evidence
selection, repair, session candidate reuse, budget policy, or outcome logging.

## Current surface inventory

| Surface | Current execution path | Kernel-backed today? | Cutover target |
| --- | --- | ---: | --- |
| `fusionkit codex` | CLI -> KernelBackend -> legacy FusionBackend -> panel capture -> Python fuse | Kernel-wrapped | native `fusion-frontdoor-turn` |
| `fusionkit claude` | Same stack, Anthropic dialect | Kernel-wrapped | same workflow; dialect adapter only |
| `fusionkit cursor` | Same stack, Cursor bridge/ACP/IDE | Kernel-wrapped | same workflow; Cursor adapter only |
| `fusionkit fusion <tool>` | Generic dispatcher to `runFusion` | Kernel-wrapped | same as tool shortcuts |
| `fusionkit serve` | Starts kernel-wrapped fusion gateway | Kernel-wrapped | gateway dispatches every turn into native workflow |
| `fusionkit local <tool>` | kernel-wrapped local gateway over direct backend | Kernel-wrapped | native `direct-model-turn` |
| `fusionkit ensemble run` | `runEnsemble` wrapper -> legacy operator | Kernel-wrapped | decomposed `ensemble-run` |
| `fusionkit ensemble e2e` | `runUnifiedHarnessE2E` -> `runEnsemble` wrapper | Kernel-wrapped | e2e adapter -> decomposed workflow |
| Node `/v1/chat/completions` | protocol adapter -> backend.chat | Only fused panel capture | backend execution via workflow |
| Node `/v1/responses` | responses adapter -> backend.chat | Only fused panel capture | adapter only; kernel owns execution |
| Node `/v1/messages` | Anthropic adapter -> backend.chat | Only fused panel capture | adapter only; kernel owns execution |
| Python `/v1/fusion/trajectories:fuse` | Python `FusionKernel` -> judge/synth | Kernel-wrapped | TS-native fuse operator or sidecar operator |
| Python `/v1/chat/completions` | Python `FusionKernel` -> `FusionEngine` | Kernel-wrapped | legacy or forwards into TS kernel |
| Python `/v1/fusion/runs` | Python `FusionKernel` -> `FusionRunManager` | Kernel-wrapped | legacy or replaced by kernel run store |

## Required workflow inventory

### `direct-model-turn`

Used by local mode, local serve, and any explicit degree-1 path.

Must preserve:

- streaming provider deltas;
- tool calls when the model emits them;
- provenance and cost metering;
- direct first-token latency;
- no hidden panel, judge, synth, ranker, verifier, or repair.

### `native-passthrough-turn`

Used when a tool picker selects a native panel model.

Must preserve:

- endpoint-id routing;
- model discovery/listing;
- streaming;
- provider failure normalization;
- cost metering;
- trace visibility.

### `native-passthrough-with-failover`

Used for transient/quota provider failures.

Must preserve:

- failover only for transient/quota classes;
- no failover for auth or unknown failures;
- pre-stream handoff to fusion;
- mid-stream resume notice;
- exclusion of the failed endpoint from the panel.

### `panel-capture-turn`

Used by product fusion turns and harness/eval paths.

Must preserve:

- tool-specific harness kind;
- panel identity option;
- harness system prompt passthrough;
- per-model endpoint routing;
- worktree isolation;
- failed-candidate attribution;
- `WireTrajectory` output.

### `trajectory-fuse-step`

Compatibility step for current Python synthesis.

Must preserve:

- judge/synth model selection;
- candidate trajectories;
- live conversation messages;
- tools and tool choice;
- streaming final response;
- terminal `fusion` extension;
- synthesis metadata.

### `fusion-frontdoor-turn`

Primary fused product turn:

```text
BudgetGate
  -> ResolveSession
  -> ResolveRequestedModel
  -> NativePassthroughWithFailover OR
     EnsureTurnCandidates(panel-capture-turn)
       -> TrajectoryFuseStep
       -> RecordCost
       -> PersistTurn
       -> FinalizeWireResponse
```

This replaces the orchestration currently embedded in `FusionBackend`.

### `tool-continuation-turn`

Used when Codex/Claude/Cursor sends tool results back in the same user turn.

Must preserve:

- same turn number;
- same cached panel candidates;
- new judge/synth step with updated messages/tool results;
- no new panel until the next user turn.

### `ensemble-run`

Compatibility replacement for `runEnsemble`.

Must preserve:

- `HarnessRunRequestV1`;
- `HarnessCandidateRecordV1`;
- `HarnessRunResultV1`;
- `JudgeSynthesisRecordV1`;
- artifact store layout;
- model call records;
- tool records;
- worktree diffs;
- final patch path;
- cleanup behavior.

### `python-fusion-legacy-step`

Temporary compatibility operator for Python `trajectories:fuse`.

Inputs:

- messages;
- trajectories;
- tools;
- tool choice;
- judge/synth model IDs;
- stream flag.

Outputs:

- OpenAI-compatible response events;
- final answer artifact;
- synthesis artifact;
- usage/cost observation.

## Streaming runtime status

Product cutover is blocked until streaming operators are wired through the
gateway path. Current product behavior depends on sending an SSE response
immediately and emitting keepalive comments while panel work runs.

PR #37 includes the public event contract and a real graph-level
`FusionRuntime.stream(...)` engine: it executes the graph exactly once and
forwards every streaming operator's live events (`output.delta`,
`tool_call.delta`, `keepalive`, operator trace events) in order, then yields a
terminal `final` (or `error`) event carrying the full result. `ModelGenerateOperator`
implements `stream(...)` for provider token deltas. The remaining product cutover
is to route the gateway's SSE assembly (currently in `FusionBackend`) through this
engine so Codex/Claude/Cursor sessions stream through operators end to end.

```ts
type RuntimeEvent =
  | TraceEvent
  | { type: "output.delta"; artifactId?: string; content: string }
  | { type: "tool_call.delta"; callId: string; delta: unknown }
  | { type: "keepalive" }
  | { type: "final"; result: RuntimeExecutionResult }
  | { type: "error"; error: RuntimeExecutionError };

interface StreamingOperator extends Operator {
  stream?(inputs: readonly Artifact[], ctx: OperatorRunContext): AsyncIterable<RuntimeEvent>;
}

class FusionRuntime {
  stream(input: RuntimeRunInput): AsyncIterable<RuntimeEvent>;
}
```

Direct fast path must stream provider tokens through without waiting for final
artifact materialization.

## Session-state status

`RuntimeState` is per-run. Product turns need durable session state:

```ts
type KernelSessionState = {
  sessionId: string;
  traceId: string;
  sessionSpanId: string;
  turns: Record<number, TurnState>;
  cost: SessionCost;
  metadata: SessionMeta;
};

type TurnState = {
  turn: number;
  candidateArtifactIds: string[];
  replayRecordId?: string;
  status: "pending" | "succeeded" | "failed";
};
```

PR #37 includes `KernelSessionState`, `KernelTurnState`,
`KernelStateStore`, and `InMemoryKernelStateStore`. `FusionBackend` no longer
keeps private session/candidate/cost maps: session identity, the per-turn
candidate cache, and the running cost ledger all live behind a single
`FusionBackendKernelStateStore` (see `InMemoryFusionBackendKernelStateStore`),
which is the structural equivalent of the runtime's canonical store for the
gateway surface. Session identity and turn candidates are TTL-scoped; the cost
ledger is process/durable-scoped and written through to the durable
`SessionStore`.

## Migration phases

### Phase 0: substrate PR

Mergeable scope:

- runtime substrate;
- direct/static DAG execution;
- workflow registry and recipes;
- panel capture wrapper;
- docs and demo;
- explicit statement that advanced scheduler families are scaffolds.

### Phase 1: compatibility workflows

Add workflows that wrap current behavior without changing product semantics:

- `legacy-ensemble-run`;
- `legacy-panel-capture`;
- `legacy-trajectory-fuse-step`;
- `legacy-fusion-frontdoor-turn`;
- `legacy-local-direct-turn`.

Status in PR #37:

- `runEnsemble` runs through the named `ensembleRunWorkflow` kernel workflow.
- `legacy-ensemble-run` and `legacy-trajectory-fuse-step`
  compatibility workflows/operators exist.
- CLI local and fusion-step gateways wrap their backend calls in
  `KernelBackend`, so the HTTP backend execution surface enters the kernel, and
  the wrapper emits a typed `wire_response` artifact (not just a raw `Response`).
- The gateway's `trajectories:fuse` step runs through the shared
  `createKernelFuseStepRunner` kernel operator (typed request/response wire
  artifacts) as the product default — the gateway no longer direct-`fetch`es the
  Python step on the product path.
- Panel capture runs through the kernel (`runFusionPanels` /
  `runFusionPanelWorkflow`).
- `FusionBackend` session/candidate/cost state lives in a single kernel state
  store (`FusionBackendKernelStateStore`).
- Python FastAPI routes call `FusionKernel`, which wraps the current
  `FusionEngine` and `FusionRunManager` internals.

Remaining follow-up (deliberate architectural boundary): `FusionBackend`'s
imperative turn glue — SSE framing, rate-limit/credit failover branching, and
native-passthrough proxying — is still expressed as procedural code rather than
as discrete kernel operators. Operator-izing it requires inverting the
`model-gateway` ↔ `ensemble` dependency (so the gateway turn can be composed from
runtime operators) and re-plumbing the streaming inversion-of-control through the
streaming engine above. The expensive, side-effecting phases (panel, fuse) and
all turn state already run through the kernel; this last sliver is tracked as
Phase 2 and is intentionally not rewritten in this PR to avoid regressing the
heavily-tested gateway streaming/failover/cost paths.

### Phase 2: kernel-backed `FusionBackend`

Replace bespoke `FusionBackend` orchestration with `fusion-frontdoor-turn`.

Gate:

- existing gateway tests pass unchanged;
- streaming first-byte/keepalive behavior preserved;
- native passthrough/failover tests pass;
- durable session resume tests pass.

### Phase 3: `runEnsemble` wrapper

Make `runEnsemble` call `ensemble-run`. The first version can use a
`LegacyRunEnsembleOperator`, then decompose into real operators.

### Phase 4: local mode

Make `fusionkit local` and local serve use `direct-model-turn`.

### Phase 5: Python behind an operator

Stop calling Python synthesis directly from gateway code. Call it through
`python-fusion-legacy-step`.

### Phase 6: TS-native fusion orchestration

Port or replace Python orchestration once parity is proven.

### Phase 7: real adaptive schedulers

Add concrete adaptive state/policies for:

- execution-guided select/repair;
- tree search;
- learned routing/coordinator;
- offline architecture search.

## Parity test checklist

Before product cutover, add differential tests for:

1. `fusionkit codex` mock turn;
2. `fusionkit claude` mock turn;
3. `fusionkit cursor` mock turn;
4. `fusionkit serve` OpenAI chat turn;
5. `/v1/responses`;
6. `/v1/messages`;
7. local direct chat;
8. native passthrough;
9. rate-limit failover;
10. panel all-failed;
11. panel partial-failed;
12. tool-call continuation;
13. follow-up user turn;
14. persisted session resume.

Streaming tests must assert:

- direct path streams before final artifact;
- fusion path emits keepalive while panel runs;
- terminal errors after SSE start are emitted as SSE error events;
- native passthrough streams verbatim;
- mid-stream native failure produces resume notice.

Contract tests must assert:

- `WireTrajectory` normalization;
- harness request/candidate/result records;
- judge synthesis records;
- runtime replay schema;
- artifact provenance;
- leakage monotonicity.

## No-bypass rules after cutover

Once compatibility workflows exist:

- CLI product surfaces must select workflow IDs, not call old execution
  functions directly.
- Gateway protocol adapters must translate dialects, not choose fusion policy.
- Python may remain a legacy operator service, not a second product
  orchestration engine.
