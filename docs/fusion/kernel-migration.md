# FusionKit kernel migration and cutover plan

Status: product cutover for the runtime kernel introduced in PR #37 — the fusion
front-door turn is now native (this doc records the plan and its completed
state).

The fusion front-door surfaces (`fusionkit codex / claude / cursor / serve`) now
execute every turn as a named kernel graph. `FusionBackend` is a kernel-native
surface adapter: it maps the gateway wire contract onto `FusionRuntime`
workflows and owns only the side-effecting wire (session identity, panel/fuse
implementations, cost/trace/persistence) that the operators invoke.

```text
fusionkit codex / claude / cursor / serve
  -> CLI launcher -> startFusionStack -> startFusionStepGateway
  -> FusionBackend (kernel-native surface adapter)
     -> fusion-frontdoor-turn graph
        buffered:  frontdoor.panel -> frontdoor.fuse -> frontdoor.finalize   (FusionRuntime.run)
        streamed:  frontdoor.panel -> frontdoor.fuse.stream                  (FusionRuntime.stream)
     -> fusion-passthrough-turn graph
        frontdoor.passthrough  (vendor proxy; failover re-enters the fusion turn)
  -> frontdoor.panel      -> runFusionPanels / runFusionPanelWorkflow (kernel)
  -> frontdoor.fuse[.stream] -> createKernelFuseStepRunner -> Python trajectories:fuse (kernel operator)
  -> eventsToSseResponse  -> gateway streaming back to the tool
```

This matches the target architecture — one canonical execution plane:

```text
Surface adapter
  -> request/task adapter
  -> workflow registry
  -> FusionRuntime / streaming FusionRuntime
  -> operators
  -> stores: artifact, session, trace, outcome
  -> response adapter
```

Surface adapters may own CLI flags, protocol dialects, auth headers, process
launch, and HTTP route shape. They must not own fusion decisions such as direct
vs panel, native passthrough, failover, candidate generation, evidence
selection, repair, session candidate reuse, budget policy, or outcome logging.
Today `FusionBackend.chat` still makes the first surface routing decision
(budget gate + native-passthrough detection) before immediately dispatching to a
named kernel graph; promoting `BudgetGate` and `ResolveRequestedModel` into a
higher-level `frontdoor-request` graph is a possible future refinement, not a
requirement.

## Current surface inventory

| Surface | Current execution path | Kernel-backed today? | Cutover target |
| --- | --- | ---: | --- |
| `fusionkit codex` | CLI -> FusionBackend -> `fusion-frontdoor-turn` graph (panel -> fuse -> finalize) | Kernel-native | done |
| `fusionkit claude` | Same stack, Anthropic dialect | Kernel-native | done; dialect adapter only |
| `fusionkit cursor` | Same stack, Cursor bridge/ACP/IDE | Kernel-native | done; Cursor adapter only |
| `fusionkit fusion <tool>` | Generic dispatcher to `runFusion` | Kernel-native | done |
| `fusionkit serve` | Fusion gateway dispatches every turn into a named workflow | Kernel-native | done |
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

Implemented (see "Native cutover complete" below). The shipped graph is
`frontdoor.panel -> frontdoor.fuse -> frontdoor.finalize` (buffered) /
`frontdoor.panel -> frontdoor.fuse.stream` (streamed), with the vendor branch as
the `fusion-passthrough-turn` graph (`frontdoor.passthrough`). `BudgetGate` and
`ResolveRequestedModel` remain surface routing in `FusionBackend.chat` that
immediately dispatches into these named graphs; session resolution and turn
candidate caching are the panel operator's implementation backed by the kernel
state store.

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
`tool_call.delta`, `sse.chunk`, `keepalive`, operator trace events) in order,
then yields a terminal `final` (or `error`) event carrying the full result.
`ModelGenerateOperator` implements `stream(...)` for provider token deltas.

The gateway's streaming SSE assembly is now routed through this engine: the
streaming front-door turn runs as `panel -> fuse.stream`, the
`frontdoor.fuse.stream` operator pipes the Python step's SSE bytes as `sse.chunk`
events, and the `eventsToSseResponse` surface adapter serializes them (with
keepalives during the panel phase and a terminal error event on failure) into the
exact wire the harnesses expect. Codex/Claude/Cursor sessions therefore stream
through operators end to end.

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

Native cutover complete: the `model-gateway` ↔ `ensemble` dependency was inverted
by extracting the runtime substrate into the standalone `@fusionkit/kernel`
package (both packages now depend on it), so `FusionBackend` composes the turn
from runtime operators directly. Every front-door turn is dispatched as a named
kernel graph:

- `fusion-frontdoor-turn` (buffered): `frontdoor.panel -> frontdoor.fuse ->
  frontdoor.finalize`, run via `FusionRuntime.run`.
- `fusion-frontdoor-turn` (streamed): `frontdoor.panel -> frontdoor.fuse.stream`,
  run via `FusionRuntime.stream` and serialized by `eventsToSseResponse`.
- `fusion-passthrough-turn`: `frontdoor.passthrough` (vendor proxy), whose
  rate-limit/credit failover re-enters the fusion front-door turn with the
  throttled vendor excluded.

`FusionBackend` is now a kernel-native surface adapter: it owns only the wire
(session identity, panel/fuse implementations, cost/trace/persistence) that the
operators invoke, while the runtime owns admission, provenance, budget, trace,
and replay. The redundant outer `KernelBackend` wrapper around the fusion gateway
was removed. The vendor-proxy SSE peeking used for mid-stream resume notices
(`#proxyNativeStream`) remains the `frontdoor.passthrough` operator's transport
implementation, consistent with the operator pattern (an operator wraps its
side-effecting wire, e.g. `ModelGenerateOperator` wrapping a `ModelClient`).

### Phase 2: kernel-backed `FusionBackend` (done)

Bespoke `FusionBackend` orchestration is replaced with the `fusion-frontdoor-turn`
and `fusion-passthrough-turn` kernel workflows (see "Native cutover complete"
above).

Gate (all met):

- existing gateway tests pass unchanged (99 gateway tests + new frontdoor
  operator tests);
- streaming first-byte/keepalive behavior preserved (`eventsToSseResponse`);
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
