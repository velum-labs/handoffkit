# FusionKit documentation

FusionKit runs ensembles of local and cloud models, as a raw inference endpoint
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

Read [Documentation taxonomy](documentation-taxonomy.md) first if you are adding,
moving, or auditing docs. It defines every category and justifies every entry in
this tree.

| Page | Category | Use it for |
| --- | --- |
| [Documentation taxonomy](documentation-taxonomy.md) | Orientation | Category definitions, placement rules, and entry justification. |
| [Product scope](scope.md) | Orientation | Which packages are the ensemble product versus retained governance and VM depth. |
| [Repository coverage map](repository-coverage-map.md) | Orientation | Every major repo area mapped to its owning documentation. |
| [Repository reference](repository-reference.md) | Reference | Comprehensive package, API, app, example, protocol, and operations map. |
| [Source symbol index](source-symbol-index.md) | Reference | Source-grounded TypeScript export and Python symbol inventory. |
| [Generated code API reference](generated/code-api.md) | Reference | API reference emitted from TypeScript JSDoc and Python docstrings. |
| [Quickstart: inference endpoint](quickstart-inference.md) | Task guide | `fusionkit serve` as an OpenAI-compatible endpoint with curl streaming and tools. |
| [Quickstart: coding harness](quickstart-harness.md) | Task guide | `fusionkit codex`, `claude`, `cursor`, `--ide`, auto-wiring, fused versus passthrough. |
| [Quickstart: rate-limit handoff](quickstart-handoff.md) | Task guide | `--on-rate-limit`, failover behavior, and one-tap resume. |
| [CLI reference](cli.md) | Reference | The shipped `fusionkit` command surface, flags, sessions, cost, and budget. |
| [Configuration](configuration.md) | Reference | The one config source of truth (`.fusionkit/`) and precedence. |
| [Model catalog](model-catalog.md) | Reference | Panel providers, local MLX, open-weight endpoints, pricing, and budgets. |
| [Fusion Harness Gateway](fusion-harness-gateway.md) | Concepts and architecture | The front door: dialect translation, streaming, per-harness wiring. |
| [Fusion Judge Trajectory](fusion-judge-trajectory.md) | Concepts and architecture | How trajectories are produced and synthesized. |
| [TypeScript reference](typescript-reference.md) | Reference | Package-by-package TypeScript exports, functions, classes, and usage examples. |
| [Python reference](python-reference.md) | Reference | Python packages, modules, public classes, functions, CLI commands, and examples. |
| [Specs and APIs](specs-and-apis.md) | Reference | Protocol schemas, generated bindings, HTTP APIs, trace events, and contract workflow. |
| [Apps and examples](apps-and-examples.md) | Reference | Standalone apps, every example package, demo commands, and expected behavior. |
| [Operations and scripts](operations-and-scripts.md) | Operations | Root scripts, release files, CI workflows, dependency policy, and verification commands. |

## Out-of-product-scope topic docs

These pages document the **governance / VM-isolation** packages that remain in
the tree but are not part of the ensemble product (see [Product scope](scope.md)):

- [Concepts](concepts.md): contracts, receipts, planes, runners, sessions, checkpoints, handoffs.
- [Architecture](architecture.md), [Package guide](packages.md), [Operations](operations.md).
- [Handoff SDK](handoff-sdk.md): the continuation-first developer API on the governance primitives.
- [Examples](examples.md): the governed-run demo suite.

## Other topic docs

- [FusionKit handoff executor](fusionkit-handoff-executor.md)
- [Release publishing](release-publishing.md)

## Taxonomy summary

- Orientation pages route readers and define scope.
- Task guides complete a concrete workflow with commands and expected results.
- Concepts and architecture pages explain mental models and boundaries.
- Reference pages document exact surfaces such as commands, fields, packages, APIs,
  examples, and scripts.
- Operations pages document CI, release, publishing, self-hosting, and recovery.
- Evaluation and tuning pages document benchmark and optimization workflows.
- Design archive pages preserve historical context without presenting it as
  current product truth.

The full inventory is in [Documentation taxonomy](documentation-taxonomy.md).

## Repository at a glance

- `packages/` contains the TypeScript pnpm workspace. Start with
  [TypeScript reference](typescript-reference.md) for package ownership and
  public symbols.
- `python/` contains the uv workspace. Start with
  [Python reference](python-reference.md) for module ownership, classes, CLI
  commands, and examples.
- `spec/` contains schemas, OpenAPI contracts, generated bindings, fixtures, and
  design specs. Start with [Specs and APIs](specs-and-apis.md).
- `apps/` and `examples/` contain standalone apps and runnable demos. Start with
  [Apps and examples](apps-and-examples.md).
- `scripts/`, `release/`, and `.github/workflows/` contain maintainer
  automation. Start with [Operations and scripts](operations-and-scripts.md).

## Documentation conventions

- Prefer linking to package entry points instead of duplicating API signatures.
- Keep public package entry points annotated with module JSDoc or Python
  docstrings, then run `pnpm docs:generate-code` to refresh
  [Generated code API reference](generated/code-api.md).
- Keep policy/security claims tied to implemented controls in `packages/plane`,
  `packages/runner`, `packages/protocol`, and the session backend packages.
- Treat root `README.md` as the user-facing landing page; put deeper operational
  and maintainer detail here.
