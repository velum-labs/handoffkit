# Judge-streamed trajectory fusion

`fusionkit <tool>` fuses several panel models into one coding agent. The
**harness is the single launched tool** (`fusionkit codex` / `claude` /
`cursor`): every panel model runs THROUGH that one harness in its own local git
worktree, getting the harness's real tools + context, and only the underlying
routed model varies. Each panel run produces a native trajectory, reconstructed
from the normalized provider wire traffic the gateway already proxies (no
per-CLI stdout parsing). The **judge** (the configured `judgeModel`) compares
the candidate trajectories and finds the gaps, and the **synthesizer** runs as
the launched harness's own streaming tool-calling loop, fed the candidates plus
the judge analysis, emitting the fused trajectory the harness executes in the
user's repo. There is no apply/verify/repair step and fusionkit owns no
verification. Iteration and any test runs are the harness's job.

## The abstraction

- **CandidateTrajectory**: one panel model's full reasoning / tool-call /
  observation / output for the task (the reference solutions), reconstructed at
  the gateway wire boundary ([trajectory-capture.ts](../packages/fusion-gateway/src/trajectory-capture.ts))
  from the launched harness's model calls. It supports three provider dialects, no per-CLI
  stdout parsing, no verification verdict.
- **Consolidated trajectory**: the live conversation the harness resends each
  turn (the judge's prior steps plus the tool results the harness fed back).
- **FusionSession**: per front-door conversation: the candidate trajectories
  (produced once) plus the running consolidated trajectory.

Each front-door turn, the judge is given the candidate trajectories + the
consolidated conversation + the harness's own tools, and emits the next step:
either tool calls for the harness to execute, or the final answer.

## Data flow

```mermaid
flowchart TB
  cli["User harness CLI (codex / claude / cursor-agent)"]
  gw["Gateway /v1/responses|messages|chat -> FusionBackend"]
  panels["Panel (once per session): gpt + sonnet + gemini -> candidate trajectories"]
  step["FusionKit /v1/fusion/trajectories:fuse (judge agent)"]
  dash["scope dashboard (collector + UI)"]

  cli -->|messages + tools| gw
  gw -->|first turn only| panels
  panels -->|candidate trajectories| step
  gw -->|messages + tools + candidates| step
  step -->|streamed assistant step (+ tool_calls)| gw
  gw -->|dialect-native SSE| cli
  cli -->|executes tools, returns results| gw
  gw -. session / candidate / model.call / judge.* events .-> dash
```

When the judge emits a step with no tool calls, that is the final answer and
the harness loop ends.

## Components

| Concern | Location |
|---|---|
| Judge gap-analysis + synthesizer step over candidates + conversation | [python/fusionkit-server/.../app.py](../python/fusionkit-server/src/fusionkit_server/app.py) `POST /v1/fusion/trajectories:fuse`, [judge.py](../python/fusionkit-core/src/fusionkit_core/judge.py) `JudgeSynthesizer.fuse` runs `analyze()` then injects the analysis into `build_fuse_system` |
| Native trajectory reconstruction at the wire boundary | [packages/fusion-gateway/src/trajectory-capture.ts](../packages/fusion-gateway/src/trajectory-capture.ts), captured via `ProvenanceSink.onModelCallRaw` |
| Front-door backend: panels-once + per-turn proxy, immediate streaming + keepalive | [packages/fusion-gateway/src/fusion-backend.ts](../packages/fusion-gateway/src/fusion-backend.ts) |
| Dialect adapters (chat / responses / anthropic) with tools + streaming | [packages/model-gateway/src/adapters/](../packages/model-gateway/src/adapters/) |
| Panel runner: run the agents once, capture trajectories | [packages/ensemble/src/unified.ts](../packages/ensemble/src/unified.ts) `runFusionPanels` |
| CLI wiring | [packages/cli/src/gateway.ts](../packages/cli/src/gateway.ts) `startFusionStepGateway`, [fusion-quickstart.ts](../packages/cli/src/fusion-quickstart.ts) |
| Observability spine + dashboard | [apps/scope](../apps/scope) |

The `model-gateway` package stays free of an `@fusionkit/ensemble` dependency: the
panel runner is injected into `FusionBackend` as a `PanelRunner`.

## Why streaming + keepalive

The panel solves the task once before the judge's first token, which can take
tens of seconds. `FusionBackend` returns the streaming response immediately and
emits SSE keepalives while the panel runs; the Responses adapter emits
`response.created` eagerly. Without this, real CLIs (codex) time out and
reconnect before the first byte.

## Observability

Every component emits OpenTelemetry spans and events named by the fusion
semantic conventions (`spec/fusion-trace/registry.json`), correlated by one
trace id: a `fusion.turn.info` event (with the environment snapshot),
`fusion.candidate` spans with live `fusion.candidate.step` events, GenAI
`chat` spans for model calls, `fusion.tool.execution` events, and the judge's
`fusion.judge.thinking` events (each tool-call step) correlated to the
terminal `fusion.judge` span. The judge span's end carries the final answer
and marks the session succeeded in the collector. Run with `--observe` to
launch the dashboard and export both signals into it (standard
`OTEL_EXPORTER_OTLP_ENDPOINT`).

## Test drive

```bash
cd /path/to/this/repo && pnpm build

# Configure provider endpoints in .routekit/router.yaml and their opaque ids in
# .fusionkit/fusion.json, then launch the configured compound.
node packages/cli/dist/index.js codex --observe --fusionkit-dir .
```

Provider keys are resolved by RouteKit from the `apiKeyEnv` references in its
router config; FusionKit receives namespaced model IDs only.

### Automated end-to-end drivers

Real, self-contained drivers live in [scripts/](../scripts):

- `node scripts/fusion-step-e2e.mjs`: drives the new gateway with a built-in
  tool-loop harness against a buggy repo and asserts it ends green.
- `node scripts/fusion-codex-e2e.mjs`: same, driven by the real `codex` CLI.
- `node scripts/fusion-observe-verify.mjs`: boots the dashboard, runs a codex
  session, and verifies the collector captured the full correlated session.

Each requires `uv`, a FusionKit checkout (`FUSIONKIT_FUSION_FK_DIR` or the default
path), and cloud API keys; they make real, billed model calls.
`FUSIONKIT_FUSION_FK_DIR` is read only by these `scripts/fusion-*.mjs` e2e
drivers; the CLI's own dev override for the Python engine checkout is
`FUSIONKIT_DIR` (or the `--fusionkit-dir` flag).
