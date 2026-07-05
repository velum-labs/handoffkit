# Repository documentation coverage map

This map ties every major repository area to the documentation that owns it. Use it when auditing comprehensiveness, reviewing a PR that touches multiple systems, or deciding where new documentation belongs.

## Coverage matrix

| Area | Primary docs | Coverage expectation |
| --- | --- | --- |
| `README.md` | Root README, `docs/README.md`, public Introduction | Product narrative, quick tour, install path, architecture summary, and links into deeper docs. |
| `packages/cli` | `docs/cli.md`, `docs/typescript-reference.md`, `docs/generated/code-api.md`, public Command Reference | Commands, flags, setup, config, sessions, models, launchers, doctor, status, and error behavior. |
| `packages/model-gateway` | `docs/fusion-harness-gateway.md`, `docs/typescript-reference.md`, `docs/generated/code-api.md`, `docs/specs-and-apis.md`, public API Reference | Gateway routes, dialect adapters, streaming, sessions, cost, rate-limit handoff, provenance, frontdoor workflows, and trajectory capture. |
| `packages/ensemble` | `docs/fusion-judge-trajectory.md`, `docs/fusion/runtime-kernel.md`, `docs/typescript-reference.md`, `docs/generated/code-api.md`, public Runtime Kernel | Panel execution, worktrees, harnesses, judge synthesis, kernel workflows, operators, schedulers, isolation, and tool execution. |
| `packages/kernel` | `docs/typescript-reference.md`, `docs/fusion/runtime-kernel.md`, public Runtime Kernel | Dependency-free runtime substrate, artifacts, operators, graphs, validation, wire artifacts, and replay records. |
| `packages/protocol` | `docs/specs-and-apis.md`, `docs/model-fusion-protocol-consumption.md`, `docs/typescript-reference.md` | Contracts, validators, hashes, signing, generated OpenAPI SDKs, trace events, and protocol consumption. |
| `packages/workspace` | `docs/typescript-reference.md`, `docs/repository-reference.md` | Git capture, materialization, safe paths, output collection, and divergence-safe pull. |
| `packages/tools` and `packages/tool-*` | `docs/typescript-reference.md`, public Package Map | Tool integration contract, registry, launchers, harness adapters, Cursor bridge, Codex, Claude Code, and opencode integration. |
| `packages/adapter-ai-sdk` | `docs/typescript-reference.md`, public Adapters | Product-local AI SDK utilities, worktree agents, and MLX server helpers. |
| `legacy/packages/plane` | `legacy/docs/concepts.md`, `legacy/docs/architecture.md`, `docs/typescript-reference.md`, public Core Concepts | Control plane, policy, approvals, principals, secrets, contracts, receipts, metrics, retention, and UI. |
| `legacy/packages/runner` | `legacy/docs/concepts.md`, `legacy/docs/architecture.md`, `docs/typescript-reference.md`, public Self-hosting | Claim loop, execution preparation, session backend lifecycle, egress integration, and runner receipts. |
| `legacy/packages/sdk` | `docs/typescript-reference.md`, public Plane SDK | Plane client and offline receipt verification helpers. |
| `legacy/packages/handoff` | `legacy/docs/handoff-sdk.md`, `docs/typescript-reference.md`, public Handoff SDK | Continuations, checkpoints, `continueIn`, review, pull, tools, routing, triggers, and policies. |
| `legacy/packages/adapter-compute` | `docs/typescript-reference.md`, public Adapters | ComputeSDK-shaped sandbox surface backed by governed sessions. |
| `legacy/packages/session-*` | `docs/typescript-reference.md`, `legacy/docs/architecture.md`, public Self-hosting | Hermetic sessions, Vercel Sandbox sessions, AI SDK harness sessions, transcript recording, and auth helpers. |
| `packages/testkit` and `packages/example-utils` | `docs/typescript-reference.md`, `docs/apps-and-examples.md` | Test fixtures, in-process stacks, git fixtures, example manifests, narration, and mock models. |
| `python/fusionkit-core` | `docs/python-reference.md`, `docs/generated/code-api.md`, `docs/specs-and-apis.md` | Config, clients, fusion engine, judge, run manager, contracts, run store, providers, prompts, traces, artifacts, metrics, and producers. |
| `python/fusionkit-server` | `docs/python-reference.md`, `docs/generated/code-api.md`, public Inference endpoint, public API Reference | FastAPI app, OpenAI-compatible routes, trajectory fusion route, and native run endpoints. |
| `python/fusionkit-cli` | `docs/python-reference.md`, `docs/generated/code-api.md`, public Inference endpoint | Python CLI commands, auth commands, prompt dumping, benchmarks, tuning, and hill climbing. |
| `python/fusionkit-evals` | `docs/python-reference.md`, `docs/generated/code-api.md`, benchmark docs | Fusion bench, public bench, prompt tuning, hill climbing, scoring, reports, adapters, and execution selection. |
| `python/fusionkit-mlx` | `docs/python-reference.md`, `docs/generated/code-api.md`, public Models and panels | Optional MLX launch helpers and local model serving integration. |
| `python/uniroute` and `python/uniroute-mlx` | `docs/python-reference.md`, `docs/generated/code-api.md` | Routing research packages, local model bridge, router cards, evaluation helpers, and tests. |
| `apps/docs` | `docs/apps-and-examples.md`, `apps/docs/README.md`, public Documentation taxonomy | Public docs site structure, MDX content, OpenAPI generation, Fumadocs setup, Mermaid, build, and deployment. |
| `apps/scope` | `docs/apps-and-examples.md`, public Observability | Trace dashboard, local install, tests, trace and session correlation, and observability workflow. |
| `examples/*` | `docs/apps-and-examples.md`, public Examples | Every runnable example, scope, command, expected behavior, and maintenance rules. |
| `spec/model-fusion-contract` | `docs/specs-and-apis.md`, public API Reference | Schemas, fixtures, OpenAPI, generated bindings, contract records, and code generation workflow. |
| `spec/fusion-trace` | `docs/specs-and-apis.md`, public Observability | Trace event schema, fixtures, payload shape, and producer expectations. |
| `spec/*.md` | `docs/documentation-taxonomy.md` | Design archive material that should not be treated as current product truth unless promoted. |
| `scripts/*` | `docs/operations-and-scripts.md` | Checks, demos, releases, code generation, e2e harnesses, local servers, and monorepo helpers. |
| `release/*` | `docs/operations-and-scripts.md`, `docs/releasing.md`, `docs/release-publishing.md` | Release state, package lists, dependency graph, desired state, and publish metadata. |
| `.github/workflows/*` | `docs/operations-and-scripts.md`, release docs | CI, build, tests, demos, release workflows, docs deployment, and local equivalents. |
| `.fusionkit/*` | `docs/configuration.md`, public Configuration | Committed example config, prompt overrides, source of truth, and derived YAML behavior. |
| `.cursor/skills/*` and `.cursor/plans/*` | `docs/documentation-taxonomy.md` | Internal agent skills and planning artifacts, not public documentation. |
| `tests/*`, `test/*`, package tests | `docs/operations-and-scripts.md`, package references | Test ownership, local commands, and verification expectations for changed surfaces. |

## Coverage rules

Every new top-level directory or workspace package needs an entry in this map. Every new public CLI feature needs a task guide or command reference entry. Every new exported package symbol needs either a narrative reference entry, a generated code API entry from source comments, or a source-symbol-index entry that points to its module. Every new schema, OpenAPI route, or generated binding needs coverage in `docs/specs-and-apis.md` and the public API section when user-facing.

## Audit workflow

When reviewing documentation coverage for a code change, identify the touched directory first, then inspect the primary docs listed in the matrix. If the change modifies a public workflow, update the public site. If it modifies source ownership, generated contracts, scripts, tests, examples, or release behavior, update the maintainer docs. If the change only affects temporary implementation planning, keep it in `.cursor/plans/`.
