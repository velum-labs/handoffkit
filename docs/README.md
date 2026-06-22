# Warrant documentation

Warrant is the governed execution and provenance plane for AI agents. It lets a
developer or application run vendor agents and model-driven tools on controlled
runtimes, under policy, then receive signed receipts that can be verified
offline.

> **The canonical, user-facing documentation now lives in the Fumadocs site at
> [`apps/docs`](../apps/docs)** (published at `fusionkit.velum-labs.com`). It covers
> both the fusionkit CLI and the platform (concepts, architecture, SDKs,
> self-hosting, API reference). The Markdown pages in this directory are retained
> as an internal maintainer/contributor layer; when they overlap with the site,
> the site is the source of truth.

Use this directory as the maintainable documentation layer for the codebase. The
root [`README.md`](../README.md) remains the product narrative and quick tour;
the pages here explain how the implementation is organized and operated.

## Start here

| Page | Use it for |
| --- | --- |
| [Concepts](concepts.md) | The core nouns: contracts, receipts, planes, runners, sessions, checkpoints, and handoffs. |
| [Getting started](getting-started.md) | Local install, build, demos, Docker compose, and verification commands. |
| [Architecture](architecture.md) | How packages collaborate during governed runs and continuation flows. |
| [Package guide](packages.md) | What each workspace package owns and where to look in source. |
| [CLI reference](cli.md) | Common `warrant` workflows and command groups. |
| [Handoff SDK](handoff-sdk.md) | The continuation-first developer API built on Warrant primitives. |
| [Examples](examples.md) | The demo suite and what each scenario proves. |
| [Operations](operations.md) | Plane/runner deployment, security controls, data storage, and maintenance. |

## Existing topic docs

These focused notes document model-fusion and release workflows:

- [Fusion Harness Gateway](fusion-harness-gateway.md)
- [Fusion Claude Router](fusion-router.md)
- [Fusion Judge Trajectory](fusion-judge-trajectory.md)
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
