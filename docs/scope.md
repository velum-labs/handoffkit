# Product scope: FusionKit vs. legacy governance/VM

This repository ships the **FusionKit model-fusion product**: local + cloud
model panels behind coding harnesses and a raw fusion endpoint. It also keeps
the older **Warrant governance / VM isolation stack** in-tree under
[`legacy/`](../legacy), but that stack is not part of the product runtime.

## Shipped product surface

The Node `@fusionkit/cli` command tree (`packages/cli/src/cli.ts`) registers the
FusionKit product commands only:

- `codex` / `claude` / `cursor` / `serve`
- `init`, `setup`, `doctor`, `config`, `prompts`, `proxy`,
  `sessions`, `models`, `ensemble`, `install` / `uninstall`,
  `completion` (plus its internal completion protocol), `telemetry`,
  `version`, and top-level `stop`

No governance commands (`ui`, `runs`, `plane start`, `runner start`, Warrant
continuation commands, receipt commands, pull, secrets) are registered in the
product CLI.

## Product packages

These packages must not depend directly or transitively on the legacy packages:

| Package | Role |
| --- | --- |
| `@fusionkit/cli` | Product front door. |
| `@fusionkit/cli-ui` | Terminal presentation layer. |
| `@fusionkit/ensemble` | Panel run engine: worktrees, harness execution, judge synthesis, fusion. |
| `@fusionkit/model-gateway` | Harness gateway: dialect translation, streaming, sessions, cost, rate-limit handoff. |
| `@fusionkit/protocol` | Model-fusion data contracts and generated SDK bindings. |
| `@fusionkit/workspace` | Git workspace capture, worktree materialization, divergence-safe pull. |
| `@fusionkit/tools`, `tool-codex`, `tool-claude`, `tool-cursor`, `tool-opencode` | Per-harness adapters. |
| `@fusionkit/adapter-ai-sdk` | Managed MLX local-model helpers and product-local AI SDK utilities. |
| `@fusionkit/harness-core`, `runtime-utils`, `registry`, `kernel` | Shared product runtime, registry, and execution primitives. |
| `@fusionkit/tracing` | OpenTelemetry-backed fusion span/event helpers and trace carriers. |

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
  E2E tooling (provider simulator + real engine) for the product test suites.

The legacy packages remain publishable from this monorepo for now. Their npm
package names, scopes, repository identity, binaries, and release manifest
entries are preserved; only filesystem paths changed.

## Current boundary

The product packages no longer import or declare dependencies on the legacy
packages. Legacy-only surfaces moved out of product packages:

- CLI governance commands and the legacy plane-home config loader were removed
  from `@fusionkit/cli`.
- The CLI receipt/trace renderer moved to private `@fusionkit/example-utils` for
  legacy examples only.
- `@fusionkit/tool-claude` keeps only the local Claude Code harness path used by
  FusionKit panels; the sandbox/session-harness path is gone.
- Governed AI SDK helpers (`remoteTools`, `swarmTools`, `handoffModel`,
  `routedModel`) moved from `@fusionkit/adapter-ai-sdk` to legacy
  `@fusionkit/handoff`.
- Dead `runner` / `session-harness` dependency edges were removed from
  `@fusionkit/ensemble`.

## Deferred owner decisions

These steps are intentionally not done yet:

1. Unpublish or mark legacy packages private.
2. Extract legacy code to another repository.
3. Remove legacy demos, Docker smoke, or publish manifest entries.

Until those decisions are made, the repository continues to build, test, demo,
and publish both product and legacy packages from one workspace while keeping the
product dependency graph isolated.
