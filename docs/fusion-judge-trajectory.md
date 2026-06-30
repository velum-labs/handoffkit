# Judge-streamed trajectory fusion

`fusionkit <tool>` fuses several panel models into one coding agent. The
**harness is the single launched tool** (`fusionkit codex` / `claude` /
`cursor`): every panel model runs THROUGH that one harness in its own local git
worktree, getting the harness's real tools + context, and only the underlying
routed model varies. Each panel run produces a native trajectory, reconstructed
from the normalized provider wire traffic the gateway already proxies (no
per-CLI stdout parsing). The **judge** (the configured `judgeModel`) compares
the candidate trajectories and finds the gaps, and the **synthesizer** runs as
the launched harness's own streaming tool-calling loop — fed the candidates plus
the judge analysis — emitting the fused trajectory the harness executes in the
user's repo. There is no apply/verify/repair step and fusionkit owns no
verification — iteration (and any test runs) are the harness's job.

## The abstraction

- **CandidateTrajectory** — one panel model's full reasoning / tool-call /
  observation / output for the task (the reference solutions), reconstructed at
  the gateway wire boundary ([trajectory-capture.ts](../packages/model-gateway/src/trajectory-capture.ts))
  from the launched harness's model calls — three provider dialects, no per-CLI
  stdout parsing, no verification verdict.
- **Consolidated trajectory** — the live conversation the harness resends each
  turn (the judge's prior steps plus the tool results the harness fed back).
- **FusionSession** — per front-door conversation: the candidate trajectories
  (produced once) plus the running consolidated trajectory.

Each front-door turn, the judge is given the candidate trajectories + the
consolidated conversation + the harness's own tools, and emits the next step:
either tool calls for the harness to execute, or the final answer.

## Data flow

```mermaid
flowchart TB
  cli["User harness CLI (codex / claude / cursor-agent)"]
  gw["Gateway /v1/responses|messages|chat -> FusionBackend"]
  panels["Panel (once per session): gpt + opus -> candidate trajectories"]
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
| Native trajectory reconstruction at the wire boundary | [packages/model-gateway/src/trajectory-capture.ts](../packages/model-gateway/src/trajectory-capture.ts), captured via `ProvenanceSink.onModelCallRaw` |
| Front-door backend: panels-once + per-turn proxy, immediate streaming + keepalive | [packages/model-gateway/src/fusion-backend.ts](../packages/model-gateway/src/fusion-backend.ts) |
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

Every component emits `fusion-trace-event.v1` events correlated by one
`trace_id`: `session.started` (with the environment snapshot),
`harness.candidate.started/finished`, `trajectory.step`,
`model.call.started/finished`, `tool.execution`, and the judge's
`judge.thinking` (each tool-call step) → `judge.final` (terminal). The terminal
`judge.final` carries the final answer and marks the session succeeded in the
collector. Run with `--observe` to launch the dashboard and stream events into
it.

## Test drive

```bash
cd /Users/alen/Documents/Development/handoffkit && pnpm build

# One command: real cloud panel (gpt-5.5 + opus), judge gpt-5.5, codex as the
# front-door harness, and the scope dashboard observing it live on :4317.
node packages/cli/dist/index.js fusion codex \
  --observe \
  --fusionkit-dir . \
  --model gpt=openai:gpt-5.5 \
  --model opus=anthropic:claude-opus-4-8 \
  --judge-model gpt-5.5
```

API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) are loaded from the FusionKit
checkout's `.env`. Omit `--model` flags to use the default local MLX trio.

### Automated end-to-end drivers

Real, self-contained drivers live in [scripts/](../scripts):

- `node scripts/fusion-step-e2e.mjs` — drives the new gateway with a built-in
  tool-loop harness against a buggy repo and asserts it ends green.
- `node scripts/fusion-codex-e2e.mjs` — same, driven by the real `codex` CLI.
- `node scripts/fusion-observe-verify.mjs` — boots the dashboard, runs a codex
  session, and verifies the collector captured the full correlated session.

Each requires `uv`, a FusionKit checkout (`WARRANT_FUSION_FK_DIR` or the default
path), and cloud API keys; they make real, billed model calls.
