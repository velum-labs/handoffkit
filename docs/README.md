# FusionKit maintainer documentation

> **Documentation split:** `docs/` is the maintainer and contributor documentation layer. `apps/docs` is the canonical user documentation source, published at <https://fusionkit.velum-labs.com/docs>.

FusionKit runs panels of local and cloud models as a raw inference endpoint and behind unmodified coding harnesses (Codex, Claude Code, Cursor). The Node `@fusionkit/cli` owns the product gateway and starts an internal Python synthesis sidecar when fusion needs it.

Use this directory for implementation, release, protocol, benchmark, and historical context. When a page overlaps with the public site, the site is the source of truth and any `docs/quickstart-*.md` page is an in-repo mirror kept for existing links.

## Start here

Read [Documentation taxonomy](documentation-taxonomy.md) before adding, moving, or auditing docs.

| Page | Category | Use it for |
| --- | --- | --- |
| [Documentation taxonomy](documentation-taxonomy.md) | Orientation | Category definitions, placement rules, and entry justification. |
| [Product scope](scope.md) | Orientation | Product packages versus retained legacy governance and VM packages. |
| [Repository coverage map](repository-coverage-map.md) | Orientation | Major repo areas mapped to their owning docs. |
| [Repository reference](repository-reference.md) | Reference | Comprehensive package, API, app, example, protocol, and operations map. |
| [Getting started](getting-started.md) | Task guide | Contributor setup, local verification, portless behavior, and demos. |
| [Package guide](packages.md) | Reference | Short package guide for readers who do not need full package references. |
| [Testing](testing.md) | Task guide | RouteKit/sidecar test tooling, the coverage matrix, and the mutation pass. |
| [Hyperkit](hyperkit.md) | Reference | The SUT-agnostic experiment platform: boundary, CLI, adapters, backends, and observability. |
| [Source symbol index](source-symbol-index.md) | Reference | Source-grounded TypeScript export and Python symbol inventory. |
| [Generated code API reference](generated/code-api.md) | Reference | API reference emitted from TypeScript JSDoc and Python docstrings. |
| [CLI reference](cli.md) | Reference | Shipped `fusionkit` command surface, flags, sessions, cost, budget, and env vars. |
| [Configuration](configuration.md) | Reference | `.fusionkit/` config, precedence, prompts, and YAML export. |
| [Privacy](privacy.md) | Policy | Local storage, provider egress, rate-limit failover, and no-telemetry disclosure. |
| [Fusion Harness Gateway](fusion-harness-gateway.md) | Architecture | Dialect translation, streaming, and per-harness wiring. |
| [Subscription pooling](subscription-pooling.md) | Architecture | Provider-native relays, credential pools, usage windows, and quota-aware rotation. |
| [CLIProxyAPI upstream](cliproxy-upstream.md) | Architecture | The `cliproxy` provider: subscription models (Gemini, Grok, Kimi) on a panel via a local OAuth proxy sidecar. |
| [Fusion Judge Trajectory](fusion-judge-trajectory.md) | Architecture | Trajectory production, judge synthesis, OTel trace spans, and e2e drivers. |
| [TypeScript reference](typescript-reference.md) | Reference | TypeScript package ownership and public symbols. |
| [Python reference](python-reference.md) | Reference | Python package ownership, modules, public classes/functions, CLI commands, and examples. |
| [Specs and APIs](specs-and-apis.md) | Reference | Protocol schemas, generated bindings, HTTP APIs, trace conventions, and contract workflow. |
| [Apps and examples](apps-and-examples.md) | Reference | Apps, examples, demo commands, and expected behavior. |
| [Operations and scripts](operations-and-scripts.md) | Operations | Root scripts, release files, CI workflows, dependency policy, and verification commands. |
| [Benchmarking runbook](benchmarking-runbook.md) | Evaluation and tuning | Benchmark execution and troubleshooting runbook. |
| [Prompt tuning](prompt-tuning.md) | Evaluation and tuning | Prompt tuning workflow and reporting guidance. |
| [Public benchmark smoke](public-benchmark-smoke.md) | Evaluation and tuning | Public benchmark smoke-test workflow. |
| [Public benchmark comparison](public-benchmark-comparison.md) | Evaluation and tuning | Public benchmark comparison and reporting workflow. |

## User-doc mirrors

Canonical user docs live on the site; these mirrors remain because they are linked widely:

- [Quickstart: inference endpoint](quickstart-inference.md) -> <https://fusionkit.velum-labs.com/docs/getting-started/inference-endpoint>
- [Quickstart: coding harness](quickstart-harness.md) -> <https://fusionkit.velum-labs.com/docs/getting-started/quickstart>
- [Quickstart: rate-limit handoff](quickstart-handoff.md) -> <https://fusionkit.velum-labs.com/docs/getting-started/rate-limit-handoff>

## Legacy archive

Governance / VM-isolation documentation has moved to [`legacy/docs/`](../legacy/docs/). Start at [`legacy/README.md`](../legacy/README.md) and [`scope.md`](scope.md) before using those pages.

## Taxonomy summary

- Orientation pages route readers and define scope.
- Task guides complete a concrete workflow with commands and expected results.
- Concepts and architecture pages explain mental models and boundaries.
- Reference pages document exact surfaces such as commands, fields, packages, APIs, examples, and scripts.
- Operations pages document CI, release, publishing, self-hosting, and recovery.
- Evaluation and tuning pages document benchmark and optimization workflows.
- Design archive pages preserve historical context without presenting it as current product truth.

## Repository at a glance

- `packages/` contains the TypeScript pnpm workspace. Start with [TypeScript reference](typescript-reference.md).
- `python/` contains the uv workspace, including the `hyperkit` experiment platform. Start with [Python reference](python-reference.md).
- `spec/` contains schemas, OpenAPI contracts, generated bindings, fixtures, trace specs, and the registry data under `spec/registry/`. Start with [Specs and APIs](specs-and-apis.md).
- `apps/` and `examples/` contain standalone apps and runnable demos. Start with [Apps and examples](apps-and-examples.md).
- `scripts/`, `release/`, and `.github/workflows/` contain maintainer automation. Start with [Operations and scripts](operations-and-scripts.md).
- `lab/` is the shared Hyperkit experiment lab (registry, journal, experiment procedures). Start with [`lab/AGENTS.md`](../lab/AGENTS.md).
- `infra/` contains Hyperkit deployment infrastructure: `infra/hyperkit` (Terraform + Grafana), `infra/hypergrid-batch`, and `infra/hypergrid-obs` (deploy scripts and observability compose stack).
- `analysis/` holds analysis working sets and reports from past experiment rounds; `labruns/` holds lab run artifacts.
- `configs/` contains example fusion and benchmark-panel YAML configs.
- `docker/` contains the Hyperkit runner and controller images (`docker/hyperkit-runner`, `docker/hyperkit-controller`).
- `legacy/` quarantines the Warrant governance stack (packages, examples, Docker, specs, docs). Start with [Product scope](scope.md).

## Documentation conventions

- Prefer linking to package entry points instead of duplicating API signatures.
- Keep public package entry points annotated with module JSDoc or Python docstrings, then run `pnpm docs:generate-code` to refresh [Generated code API reference](generated/code-api.md).
- Treat root `README.md` and `apps/docs` as user-facing; put deeper operational and maintainer detail here.
