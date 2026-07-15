# Repository documentation coverage map

This map ties every major repository area to the documentation that owns it. Use it when auditing comprehensiveness, reviewing a PR that touches multiple systems, or deciding where new documentation belongs.

## Coverage matrix

| Area | Primary docs | Coverage expectation |
| --- | --- | --- |
| `README.md` | Root README, `docs/README.md`, public Introduction | Product narrative, quick tour, install path, architecture summary, and links into deeper docs. |
| `packages/cli` | `docs/cli.md`, `docs/typescript-reference.md`, `docs/generated/code-api.md`, public Command Reference | Fusion commands, setup, ensembles, prompts, sessions, models, launchers, doctor, and error behavior. |
| `packages/routekit-cli` | `docs/cli.md`, `docs/configuration.md`, `docs/typescript-reference.md`, public Command Reference | Independent router commands, endpoint/account management, direct tool launch, install/uninstall, doctor, and lifecycle behavior. |
| `packages/routekit-config`, `packages/routekit-router`, and `packages/fusion-config` | `docs/configuration.md`, `docs/fusion-harness-gateway.md`, `docs/typescript-reference.md` | RouterConfig loading and writes, embedded RouteKit composition, and Fusion v4 ensemble/prompt policy over opaque endpoint IDs. |
| `packages/model-gateway` | `docs/fusion-harness-gateway.md`, `docs/typescript-reference.md`, `docs/generated/code-api.md`, `docs/specs-and-apis.md`, public API Reference | RouteKit gateway routes, dialect adapters, streaming, endpoint pools, provider egress, and per-call provenance. It does not own Fusion sessions or front-door workflows. |
| `packages/fusion-gateway` | `docs/fusion-harness-gateway.md`, `docs/typescript-reference.md`, `docs/generated/code-api.md`, public API Reference | Fusion front-door workflows, panel/synthesis orchestration, durable sessions, aggregate budgets, trajectory capture, and local-model lifecycle. |
| `packages/ensemble` | `docs/fusion-judge-trajectory.md`, `docs/fusion/runtime-kernel.md`, `docs/typescript-reference.md`, `docs/generated/code-api.md`, public Runtime Kernel | Panel execution, worktrees, harnesses, judge synthesis, kernel workflows, operators, schedulers, isolation, and tool execution. |
| `packages/kernel` | `docs/typescript-reference.md`, `docs/fusion/runtime-kernel.md`, public Runtime Kernel | Dependency-free runtime substrate, artifacts, operators, graphs, validation, wire artifacts, and replay records. |
| `packages/protocol` | `docs/specs-and-apis.md`, `docs/model-fusion-protocol-consumption.md`, `docs/typescript-reference.md` | Contracts, validators, hashes, signing, generated OpenAPI SDKs, trace conventions, and protocol consumption. |
| `packages/workspace` | `docs/typescript-reference.md`, `docs/repository-reference.md` | Git capture, materialization, safe paths, output collection, and divergence-safe pull. |
| `packages/tools` and `packages/tool-*` | `docs/typescript-reference.md`, public Package Map | Tool integration contract, registry, launchers, harness adapters, Cursor bridge, Codex, Claude Code, and opencode integration. |
| `packages/adapter-ai-sdk` | `docs/typescript-reference.md`, public Adapters | Product-local AI SDK utilities, worktree agents, and MLX server helpers. |
| `legacy/packages/plane` | `legacy/docs/concepts.md`, `legacy/docs/architecture.md`, `docs/typescript-reference.md`, public Core Concepts | Control plane, policy, approvals, principals, secrets, contracts, receipts, metrics, retention, and UI. |
| `legacy/packages/runner` | `legacy/docs/concepts.md`, `legacy/docs/architecture.md`, `docs/typescript-reference.md`, public Self-hosting | Claim loop, execution preparation, session backend lifecycle, egress integration, and runner receipts. |
| `legacy/packages/sdk` | `docs/typescript-reference.md`, public Plane SDK | Plane client and offline receipt verification helpers. |
| `legacy/packages/handoff` | `legacy/docs/handoff-sdk.md`, `docs/typescript-reference.md`, public Handoff SDK | Continuations, checkpoints, `continueIn`, review, pull, tools, routing, triggers, and policies. |
| `legacy/packages/adapter-compute` | `docs/typescript-reference.md`, public Adapters | ComputeSDK-shaped sandbox surface backed by governed sessions. |
| `legacy/packages/session-*` | `docs/typescript-reference.md`, `legacy/docs/architecture.md`, public Self-hosting | Hermetic sessions, Vercel Sandbox sessions, AI SDK harness sessions, transcript recording, and auth helpers. |
| `packages/testkit` | `docs/testing.md`, `docs/typescript-reference.md` | Cross-stack E2E tooling: provider-simulator handle, real engine process, sim-backed router configs, SSE observation, and skip-gating. The legacy in-process plane/runner fixtures live in `legacy/packages/testkit`. |
| `packages/example-utils` | `docs/typescript-reference.md`, `docs/apps-and-examples.md` | Example manifest parsing, narration, mock models, and live-model helpers. |
| `packages/cli-ui` | `docs/typescript-reference.md`, `docs/generated/code-api.md` | Terminal presentation layer: Ink and plain presenters, prompts, and formatting. |
| `packages/harness-core` | `docs/typescript-reference.md`, `docs/generated/code-api.md` | Coding-agent harness contract: drivers, events, errors, approvals, status probes, and the driver registry. |
| `packages/registry` and `packages/routekit-registry` | `docs/typescript-reference.md`, `docs/specs-and-apis.md`, `docs/model-catalog.md` | Fusion-only aliases/presets and RouteKit-owned provider catalogs, capabilities, discovery, and pricing, respectively. |
| `packages/runtime-utils` | `docs/typescript-reference.md`, `docs/generated/code-api.md` | Shared runtime primitives: supervised spawn, cleanup, timeouts, ids, and token estimates. |
| `packages/config-core`, `packages/cli-core`, and `packages/telemetry-core` | `docs/typescript-reference.md`, `docs/generated/code-api.md`, public Package Map | Product-neutral config IO, shared CLI primitives, and parameterized telemetry consent/redaction. |
| `packages/tracing` and `packages/routekit-tracing` | `docs/specs-and-apis.md`, `docs/typescript-reference.md` | Fusion semantic-convention helpers and the generic RouteKit OpenTelemetry runtime, respectively. |
| `python/fusionkit-core` | `docs/python-reference.md`, `docs/generated/code-api.md`, `docs/specs-and-apis.md` | Sidecar config, neutral RouteKit client, fusion engine, judge, run manager, contracts, run store, prompts, traces, artifacts, metrics, and producers. |
| `python/fusionkit-server` | `docs/python-reference.md`, `docs/generated/code-api.md`, internal sidecar API reference | Internal FastAPI health, trajectory-fusion, native-run, event, and tool-resume routes; no public chat/model router. |
| `python/fusionkit-cli` | `docs/python-reference.md`, `docs/generated/code-api.md`, public Package Map | Internal `fusionkit-sidecar` entrypoint, prompt dumping, and version output; no Python `fusionkit` executable or maintainer benchmark commands. |
| `python/fusionkit-evals` | `docs/python-reference.md`, `docs/generated/code-api.md`, benchmark docs | Fusion bench, public bench, prompt tuning, hill climbing, scoring, reports, adapters, and execution selection. |
| `python/fusionkit-mlx` | `docs/python-reference.md`, `docs/generated/code-api.md`, public Models and panels | Optional MLX launch helpers and local model serving integration. |
| `python/fusionkit-testkit` | `docs/testing.md`, `docs/python-reference.md` | Scriptable RouteKit simulator (`fusionkit-sim`), opaque-ID config builders, sidecar process harness, and pytest fixtures. |
| `python/hyperkit` | `docs/hyperkit.md`, `docs/python-reference.md` | SUT-agnostic experiment platform: `hyperkit` CLI, benchmark adapters, AWS Batch and local backends, and observability. |
| `python/uniroute` and `python/uniroute-mlx` | `docs/python-reference.md`, `docs/generated/code-api.md` | Routing research packages, local model bridge, router cards, evaluation helpers, and tests. |
| `apps/docs` | `docs/apps-and-examples.md`, `apps/docs/README.md`, public Documentation taxonomy | Public docs site structure, MDX content, OpenAPI generation, Fumadocs setup, Mermaid, build, and deployment. |
| `apps/scope` | `docs/apps-and-examples.md`, public Observability | Trace dashboard, local install, tests, trace and session correlation, and observability workflow. |
| `examples/*` | `docs/apps-and-examples.md`, public Examples | The product examples: `examples/runtime-kernel` (demo id 15 in `examples/manifest.json`) and the `examples/mlx` infra tools. Legacy demos live under `legacy/examples/` and are not in the manifest. |
| `spec/model-fusion-contract` | `docs/specs-and-apis.md`, public API Reference | Schemas, fixtures, OpenAPI, generated bindings, contract records, and code generation workflow. |
| `spec/fusion-trace` | `docs/specs-and-apis.md`, public Observability | OpenTelemetry semantic-conventions registry (span names, attribute keys, sensitivity classes) and generated bindings. |
| `spec/registry/*` | `docs/specs-and-apis.md`, `docs/model-catalog.md` | Registry source data: providers, subscriptions, model and local catalogs, capabilities, pricing, and fusion defaults consumed by the generated registry bindings. |
| `spec/*.md` | `docs/documentation-taxonomy.md` | Design archive material that should not be treated as current product truth unless promoted. |
| `scripts/*` | `docs/operations-and-scripts.md` | Checks, demos, releases, code generation, e2e harnesses, local servers, and monorepo helpers. |
| `release/*` | `docs/operations-and-scripts.md`, `docs/releasing.md`, `docs/release-publishing.md` | Release state, package lists, dependency graph, desired state, and publish metadata. |
| `.github/workflows/*` | `docs/operations-and-scripts.md`, release docs | CI (`ci.yml` jobs: check, scope, stack-e2e, python, observability) plus the `release-packages.yml`, `pypi-release.yml`, and `model-fusion-protocol-release.yml` release workflows, and their local equivalents. |
| `.fusionkit/*` | `docs/configuration.md`, public Configuration | Committed example config, prompt overrides, source of truth, and derived YAML behavior. |
| `.cursor/skills/*` and `.cursor/plans/*` | `docs/documentation-taxonomy.md` | Internal agent skills and planning artifacts, not public documentation. |
| `tests/*`, `test/*`, package tests | `docs/testing.md`, `docs/operations-and-scripts.md`, package references | Test ownership, local commands, and verification expectations for changed surfaces. |
| `lab/` | `lab/AGENTS.md` | Shared Hyperkit experiment lab: registry, journal, experiment folders, and operating procedures. |
| `infra/hyperkit`, `infra/hypergrid-batch`, `infra/hypergrid-obs` | `docs/hyperkit.md`, `infra/hyperkit/README.md`, `infra/hypergrid-obs/README.md` | Hyperkit Terraform stack and Grafana dashboards, hypergrid AWS Batch deploy script, and the hypergrid observability compose stack. |
| `docker/hyperkit-runner` and `docker/hyperkit-controller` | `docs/hyperkit.md` | Container images for Hyperkit cloud runners and the controller. |
| `analysis/` | analysis folder READMEs and `docs/documentation-taxonomy.md` | Analysis working sets and reports from past experiment rounds; historical evidence, not product docs. |
| `labruns/` | `lab/AGENTS.md` | Persisted lab run artifacts organized by quarter. |
| `configs/` | `docs/configuration.md`, `docs/benchmarking-runbook.md` | Example fusion and benchmark-panel YAML configs. |

## Coverage rules

Every new top-level directory or workspace package needs an entry in this map. Every new public CLI feature needs a task guide or command reference entry. Every new exported package symbol needs either a narrative reference entry, a generated code API entry from source comments, or a source-symbol-index entry that points to its module. Every new schema, OpenAPI route, or generated binding needs coverage in `docs/specs-and-apis.md` and the public API section when user-facing.

## Audit workflow

When reviewing documentation coverage for a code change, identify the touched directory first, then inspect the primary docs listed in the matrix. If the change modifies a public workflow, update the public site. If it modifies source ownership, generated contracts, scripts, tests, examples, or release behavior, update the maintainer docs. If the change only affects temporary implementation planning, keep it in `.cursor/plans/`.
