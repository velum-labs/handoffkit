# Product scope: FusionKit vs. legacy governance/VM

This repository ships the **FusionKit model-fusion product**: local + cloud
model panels behind coding harnesses and a raw fusion endpoint. It also keeps
the older **Warrant governance / VM isolation stack** in-tree under
[`legacy/`](../legacy), but that stack is not part of the product runtime.

## Shipped product surface

The Node `@fusionkit/cli` command tree (`packages/cli/src/cli.ts`) registers the
FusionKit product commands only:

- `codex` / `claude` / `cursor` / `opencode` / `serve`
- `init`, `setup`, `doctor`, `config`, `prompts`, `sessions`, `models`,
  `ensemble`, `completion` (plus its internal completion protocol),
  `telemetry`, `version`, and top-level `stop`

No governance commands (`ui`, `runs`, `plane start`, `runner start`, Warrant
continuation commands, receipt commands, pull, secrets) are registered in the
product CLI. Provider endpoints, accounts, proxies, Codex installation, and
direct/single-model launches belong to the separately installed `routekit`
command.

## Product packages

These packages must not depend directly or transitively on the legacy packages:

| Package | Role |
| --- | --- |
| `@fusionkit/cli` | Product front door. |
| `@fusionkit/ensemble` | Panel run engine: worktrees, harness execution, judge synthesis, fusion. |
| `@routekit/gateway` | Neutral router, gateway dialects, endpoint pools, provider egress, and call provenance. |
| `@routekit/accounts` | Neutral subscription credentials, capacity pools, relays, and proxy clients. |
| `@fusionkit/gateway` | Fusion frontdoor, panel/synthesis orchestration, sessions, budgets, and local lifecycle. |
| `@fusionkit/protocol` | Model-fusion data contracts and generated SDK bindings. |
| `@fusionkit/workspace` | Git workspace capture, worktree materialization, divergence-safe pull. |
| `@routekit/tools`, `@routekit/tool-registry`, `@routekit/tool-codex`, `@routekit/tool-claude`, `@routekit/tool-cursor`, `@routekit/tool-opencode` | Product-neutral launcher, canonical registry composition, driver, and capability integrations. |
| `@fusionkit/adapter-ai-sdk` | Managed MLX local-model helpers and product-local AI SDK utilities. |
| `@routekit/harness-core` | Product-neutral harness driver contracts and shared event/process primitives. |
| `@fusionkit/registry`, `@fusionkit/kernel` | Fusion-specific registry and execution primitives. |
| `@fusionkit/tracing` | OpenTelemetry-backed fusion span/event helpers and trace carriers. |
| `@routekit/runtime`, `cli-ui`, `cli-core`, `config-core`, `telemetry-core`, `tracing` | Brand-neutral shared runtime, CLI, configuration, telemetry, and tracing foundations. |

## Legacy quarantine

The legacy stack now lives under `legacy/`:

- `legacy/packages/`: `@fusionkit/plane`, `@fusionkit/runner`,
  `@fusionkit/sdk`, `@fusionkit/handoff`, `@fusionkit/adapter-compute`,
  `@fusionkit/session-hermetic`, `@fusionkit/session-vercel-sandbox`,
  and `@fusionkit/session-harness`.
- `legacy/examples/`: governed-run, dry-run, consent, egress, handoff, swarm,
  model-escalation, control-panel, seed, microVM isolation, the `bench`
  performance-budget demo, and related demos.
- `legacy/docker/`: the Warrant compose stack and legacy-only Docker entrypoint.
- `legacy/specs/`: the governed execution, local-first handoff, microVM, and
  secret-disclosure specs.
- `legacy/packages/testkit`: the old in-process plane/runner fixture package,
  still used by the legacy demos (including `legacy/examples/bench`). The root
  `packages/testkit` is a different, repurposed package: private cross-stack
  E2E tooling (simulated upstreams + real Python sidecar) for the product test
  suites.

The legacy packages are outside the root pnpm workspace and
`release/npm-packages.json`; current npm releases publish only the RouteKit and
FusionKit packages under `packages/`.

## Current boundary

The product packages no longer import or declare dependencies on the legacy
packages. Legacy-only surfaces moved out of product packages:

- CLI governance commands and the legacy plane-home config loader were removed
  from `@fusionkit/cli`.
- The CLI receipt/trace renderer moved to private `@fusionkit/example-utils` for
  legacy examples only.
- `@routekit/tool-claude` owns one product-neutral Claude Code launcher and
  canonical driver; FusionKit adapts it in the ensemble package.
- Governed AI SDK helpers (`remoteTools`, `swarmTools`, `handoffModel`,
  `routedModel`) moved from `@fusionkit/adapter-ai-sdk` to legacy
  `@fusionkit/handoff`.
- Dead `runner` / `session-harness` dependency edges were removed from
  `@fusionkit/ensemble`.

## Deferred owner decisions

These steps are intentionally not done yet:

1. Decide the archival/distribution policy for legacy packages.
2. Extract legacy code to another repository.
3. Remove legacy demos, Docker smoke, or publish manifest entries.

Until those decisions are made, the repository keeps the legacy code in-tree
and documented separately while the product build and release graph remains
isolated.
