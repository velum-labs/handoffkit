# FusionKit kernel migration and cutover plan

Status: product cutover plan for the runtime kernel introduced in PR #37.

PR #37 makes the kernel real, but it does **not** make every product execution
surface kernel-native. The current production path remains conservative:

```text
fusionkit codex / claude / cursor / serve
  -> CLI launcher
  -> startFusionStack
  -> startFusionStepGateway
  -> FusionBackend
  -> runFusionPanels
  -> runtime kernel for panel capture only
  -> legacy runEnsemble harness capture
  -> Python trajectories:fuse
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
| `fusionkit codex` | CLI -> FusionBackend -> panel capture -> Python fuse | Partial | `fusion-frontdoor-turn` workflow |
| `fusionkit claude` | Same stack, Anthropic dialect | Partial | same workflow; dialect adapter only |
| `fusionkit cursor` | Same stack, Cursor bridge/ACP/IDE | Partial | same workflow; Cursor adapter only |
| `fusionkit fusion <tool>` | Generic dispatcher to `runFusion` | Partial | same workflow |
| `fusionkit serve` | Starts fusion gateway | Partial | gateway dispatches every turn into kernel |
| `fusionkit local <tool>` | local gateway over direct backend | No | `direct-model-turn` workflow |
| `fusionkit ensemble run` | legacy `runEnsemble` | No | `ensemble-run` workflow |
| `fusionkit ensemble e2e` | `runUnifiedHarnessE2E` -> legacy `runEnsemble` | No | e2e adapter -> kernel workflow |
| Node `/v1/chat/completions` | protocol adapter -> backend.chat | Only fused panel capture | backend execution via workflow |
| Node `/v1/responses` | responses adapter -> backend.chat | Only fused panel capture | adapter only; kernel owns execution |
| Node `/v1/messages` | Anthropic adapter -> backend.chat | Only fused panel capture | adapter only; kernel owns execution |
| Python `/v1/fusion/trajectories:fuse` | Python judge/synth | No | `python-fusion-legacy-step` operator first |
| Python `/v1/chat/completions` | Python `FusionEngine` | No | legacy or forwards into kernel |
| Python `/v1/fusion/runs` | Python `FusionRunManager` | No | legacy or replaced by kernel run store |

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

PR #37 includes the public event contract and `FusionRuntime.stream(...)`.
Non-streaming workflows emit a final event; product cutover still requires
streaming-capable operators for direct model deltas, tool-call deltas, keepalive
events, and Python/TS fuse-step streaming.

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
`KernelStateStore`, and `InMemoryKernelStateStore`. The current
`FusionBackend` session/candidate cache still needs to move behind that store
before product cutover.

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

Status in PR #37: `legacy-ensemble-run` and
`legacy-trajectory-fuse-step` compatibility workflows/operators exist. The
frontdoor/local wrappers remain follow-up work.

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
