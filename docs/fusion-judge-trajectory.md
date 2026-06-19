# Judge-streamed trajectory fusion

`warrant fusion` (the agent harness path) fuses several panel models into one
coding agent by making the **judge the front-door agent**: a panel of models
each solves the task once to produce candidate trajectories, then the judge
runs as a streaming, tool-calling agent whose trajectory the user's own harness
(codex / Claude Code / cursor-agent) executes. The judge reacts to what the
harness observes and iterates until the task is done. There is no separate
apply/verify/repair step in the gateway — iteration is the harness's job.

## The abstraction

- **CandidateTrajectory** — one panel model's full reasoning / tool-call /
  observation / result for the task (the reference solutions).
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
  step["FusionKit /v1/fusion/trajectory:step (judge agent)"]
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
| Judge step ("brain"): tool-calling completion over candidates + conversation | [packages/fusionkit-server/.../app.py](../../fusionkit/packages/fusionkit-server/src/fusionkit_server/app.py) `POST /v1/fusion/trajectory:step`, [judge.py](../../fusionkit/packages/fusionkit-core/src/fusionkit_core/judge.py) `JudgeSynthesizer.step` |
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
  --fusionkit-dir /Users/alen/Documents/Development/fusionkit \
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
