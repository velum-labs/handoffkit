# FusionKit documentation

FusionKit runs ensembles of local and cloud models — as a raw inference endpoint
and behind unmodified coding harnesses (Codex, Claude Code, Cursor). The Node
`@fusionkit/cli` is the single front door; the Python `fusionkit serve` is the
documented raw endpoint.

> **The canonical, user-facing documentation lives in the Fumadocs site at
> [`apps/docs`](../apps/docs)** (published at `fusionkit.velum-labs.com`). The
> Markdown pages in this directory are the internal maintainer/contributor
> layer; when they overlap with the site, the site is the source of truth.

Use this directory as the maintainable documentation layer for the codebase. The
root [`README.md`](../README.md) remains the product narrative and quick tour.

## Start here

| Page | Use it for |
| --- | --- |
| [Quickstart: inference endpoint](quickstart-inference.md) | `fusionkit serve` as an OpenAI-compatible endpoint (curl streaming + tools). |
| [Quickstart: coding harness](quickstart-harness.md) | `fusionkit codex` / `claude` / `cursor` (+ `--ide`); auto-wiring; fused vs. passthrough. |
| [Quickstart: rate-limit handoff](quickstart-handoff.md) | `--on-rate-limit`, failover behavior, and one-tap resume. |
| [Model catalog](model-catalog.md) | Choosing/configuring panel models (cloud, open-weight, local MLX), pricing/`--budget`. |
| [CLI reference](cli.md) | The shipped `fusionkit` command surface, flags, sessions, cost/budget. |
| [Configuration](configuration.md) | The one config source of truth (`.fusionkit/`) and precedence. |
| [Fusion Harness Gateway](fusion-harness-gateway.md) | The front door: dialect translation, streaming, per-harness wiring. |
| [Fusion Judge Trajectory](fusion-judge-trajectory.md) | How trajectories are produced and synthesized. |
| [Product scope](scope.md) | Which packages are the ensemble product vs. out-of-scope governance/VM. |
| [Getting started](getting-started.md) | Local install, build, demos, and verification commands. |

## Out-of-product-scope topic docs

These pages document the **governance / VM-isolation** packages that remain in
the tree but are not part of the ensemble product (see [Product scope](scope.md)):

- [Concepts](concepts.md) — contracts, receipts, planes, runners, sessions, checkpoints, handoffs.
- [Architecture](architecture.md), [Package guide](packages.md), [Operations](operations.md).
- [Handoff SDK](handoff-sdk.md) — the continuation-first developer API on the governance primitives.
- [Examples](examples.md) — the governed-run demo suite.

## Other topic docs

- [FusionKit handoff executor](fusionkit-handoff-executor.md)
- [Release publishing](release-publishing.md)

## Repository at a glance

- `packages/` contains the TypeScript pnpm workspace: protocol primitives,
  plane, runner, SDKs, adapters, session backends, CLI, examples support, and
  model-fusion packages.
- `examples/` contains standalone demos driven by `examples/manifest.json` and
  `pnpm demo`.
- `python/` contains the uv workspace for UniRoute and UniRoute MLX routing.
- `spec/` contains the dated product and engineering specs that motivated the
  current implementation.
- `apps/scope/` contains the local observability companion for fusion traces.

## Documentation conventions

- Prefer linking to package entry points instead of duplicating API signatures.
- Keep policy/security claims tied to implemented controls in `packages/plane`,
  `packages/runner`, `packages/protocol`, and the session backend packages.
- Treat root `README.md` as the user-facing landing page; put deeper operational
  and maintainer detail here.
