# Package guide

The TypeScript workspace is managed by pnpm. Package entry points are generally
`packages/<name>/src/index.ts`; tests live next to source under `src/test`.

This page is the short package guide. For full package ownership, exported
functions and classes, examples, and change guidance, read
[TypeScript reference](typescript-reference.md) and
[Python reference](python-reference.md). For schemas, generated bindings, and
HTTP contracts, read [Specs and APIs](specs-and-apis.md).

## Core packages

| Package | Responsibility | Start with |
| --- | --- | --- |
| `@fusionkit/protocol` | Contract, receipt, event, manifest, checkpoint, handoff, signing, hashing, and model-fusion protocol primitives. | `packages/protocol/src/index.ts` |
| `@fusionkit/workspace` | Git capture, secret-pattern denial, session materialization, output collection, and divergence-safe pull. | `packages/workspace/src/index.ts` |
| `@fusionkit/plane` | Control plane, policy, approvals, principals, secrets, receipt countersignature, SQLite store, metrics, audit export, and UI. | `legacy/packages/plane/src/plane.ts`, `legacy/packages/plane/src/server.ts` |
| `@fusionkit/runner` | Outbound claim loop, governed session execution, harness dispatch, egress enforcement integration, and runner receipts. | `legacy/packages/runner/src/runner.ts` |
| `@fusionkit/sdk` | Thin TypeScript client for the plane API plus offline receipt verification helpers. | `legacy/packages/sdk/src/index.ts` |

## Developer surfaces

| Package | Responsibility | Start with |
| --- | --- | --- |
| `@routekit/cli` | Independent `routekit` configuration, gateway serving, endpoint/account management, and coding-tool launchers. | `packages/routekit-cli/src/cli.ts`, `packages/routekit-cli/src/commands.ts` |
| `@routekit/config` | Reusable RouterConfig discovery, layered loading, validation, and atomic writes. | `packages/routekit-config/src/index.ts` |
| `@routekit/router` | Reusable embedded RouteKit router composition, including account relays and gateway ownership. | `packages/routekit-router/src/index.ts` |
| `@fusionkit/config` | Fusion-only v4 config, opaque endpoint-ID ensembles, prompt loading, validation, and atomic writes. | `packages/fusion-config/src/index.ts` |
| `@fusionkit/cli` | Fusion-only init, local-panel lifecycle, generic harness launchers, sessions, config, prompts, and observability. It composes RouteKit SDKs but never `@routekit/cli`. | `packages/cli/src/cli.ts`, `packages/cli/src/commands` |
| `@routekit/cli-ui` | Brand-configurable Ink/plain presenters, prompts, wizards, and formatting. | `packages/cli-ui/src/index.ts` |
| `@routekit/cli-core` | CLI context, errors, shared option parsing, completion, package versions, and test helpers. | `packages/cli-core/src/index.ts` |
| `@fusionkit/handoff` | Continuation SDK: checkpoints, `continueIn`, parallel fan-out, review, pull, tools, model routing, and trace logs. | `legacy/packages/handoff/src/handoff.ts` |
| `@fusionkit/adapter-ai-sdk` | Product-local AI SDK utilities, worktree agents, local model adapters, and managed MLX helpers. | `packages/adapter-ai-sdk/src/index.ts` |
| `@fusionkit/adapter-compute` | ComputeSDK-shaped sandbox surface backed by governed runner sessions. | `legacy/packages/adapter-compute/src/sandbox.ts` |
| `@routekit/gateway` | Neutral HTTP gateway, dialect adapters, runtime router/catalog, pooled endpoints, provider egress, and single-call provenance. | `packages/model-gateway/src/index.ts` |
| `@routekit/accounts` | Subscription credentials, reusable account pooling, provider relays, proxy clients, and managed CLIProxyAPI lifecycle. | `packages/accounts/src/index.ts` |
| `@fusionkit/gateway` | Fusion frontdoor, panel/synthesis orchestration, sessions, aggregate budgets, trajectory conversion, and local lifecycle. | `packages/fusion-gateway/src/index.ts` |

## Session and harness packages

| Package | Responsibility | Start with |
| --- | --- | --- |
| `@fusionkit/session-hermetic` | just-bash virtual filesystem backend with interpreter-enforced egress and no real process/socket escape path. | `legacy/packages/session-hermetic/src/index.ts` |
| `@fusionkit/session-vercel-sandbox` | Firecracker microVM backend through Vercel Sandbox with domain egress policy. | `legacy/packages/session-vercel-sandbox/src/index.ts` |
| `@fusionkit/session-harness` | AI SDK harness bindings for vendor coding agents in governed sessions. | `legacy/packages/session-harness/src/index.ts` |
| `@fusionkit/ensemble` | FusionKit runtime kernel, typed operator graphs, schedulers, workflow recipes, harness-agnostic model-fusion runner, artifacts, worktrees, dashboards, judge synthesis, and protocol records. | `packages/ensemble/src/index.ts`, `packages/ensemble/src/kernel.ts`, `packages/ensemble/src/workflows.ts` |
| `@fusionkit/kernel` | Dependency-free runtime kernel substrate: artifacts, operators, graphs, validation, wire artifacts, and replay records. | `packages/kernel/src/index.ts` |
| `@routekit/harness-core` | Product-neutral coding-agent driver, event, error, approval, and status contracts. | `packages/harness-core/src/index.ts` |
| `@routekit/tools` | Neutral launcher, canonical-driver, and capability registry. | `packages/tools/src/index.ts` |
| `@routekit/tool-codex`, `tool-claude`, `tool-cursor`, `tool-opencode` | One launcher/serializer and one canonical driver per coding tool. | `packages/tool-<name>/src/index.ts` |

## Support packages

| Package | Responsibility | Start with |
| --- | --- | --- |
| `@fusionkit/registry` | Typed accessors over the generated `spec/registry/*.json` data: providers, catalogs, capabilities, and pricing. | `packages/registry/src/index.ts` |
| `@routekit/runtime` | Shared process supervision, child environments, cleanup, atomic files, locks, ports, and portless registration. | `packages/runtime-utils/src/index.ts` |
| `@routekit/config-core` | Layered config resolution, validated JSON IO, migration, and edit primitives. | `packages/config-core/src/index.ts` |
| `@routekit/telemetry-core` | Parameterized consent, redaction, anonymous events, and bounded shutdown. | `packages/telemetry-core/src/index.ts` |
| `@routekit/tracing` | Generic OpenTelemetry providers, propagation, listeners, and export redaction. | `packages/routekit-tracing/src/index.ts` |
| `@fusionkit/tracing` | Fusion semantic-convention facade over `@routekit/tracing`. | `packages/tracing/src/index.ts` |
| `@fusionkit/testkit` | Cross-stack E2E tooling (never published): provider simulator handle, real engine process, sim-backed router configs, and SSE observation. Legacy plane/runner fixtures live in `legacy/packages/testkit`. | `packages/testkit/src/index.ts`, `docs/testing.md` |
| `@fusionkit/example-utils` | Shared demo manifest parsing, narration, and live-model helpers. | `packages/example-utils/src/index.ts` |

## Python packages

| Package | Responsibility | Start with |
| --- | --- | --- |
| `fusionkit-core` | Core fusion engine: config, provider clients, judge, run manager, contracts, tracing, and artifacts. | `python/fusionkit-core` |
| `fusionkit-server` | FastAPI app and OpenAI-compatible HTTP routes for the fusion engine. | `python/fusionkit-server` |
| `fusionkit` | The PyPI CLI (`fusionkit serve`, init, auth, prompts, benchmarks, tuning, hill climbing). | `python/fusionkit-cli` |
| `fusionkit-evals` | Benchmarks, public reports, prompt tuning, Pareto analysis, hill climbing, scoring, and sandbox execution. | `python/fusionkit-evals` |
| `fusionkit-mlx` | Optional MLX launcher utilities for Apple Silicon local serving. | `python/fusionkit-mlx` |
| `fusionkit-testkit` | Scriptable provider simulator (`fusionkit-sim`), config builders, engine process harness, and pytest fixtures. | `python/fusionkit-testkit`, `docs/testing.md` |
| `hyperkit` | SUT-agnostic experiment platform: `hyperkit` CLI, benchmark adapters, and AWS Batch/local backends. | `python/hyperkit`, `docs/hyperkit.md` |
| `uniroute` | NumPy implementation of dynamic-pool UniRoute model routing. | `python/uniroute/README.md` |
| `uniroute-mlx` | OpenAI-compatible and MLX-serving bridge for evaluating and serving routed local models. | `python/uniroute-mlx/README.md` |
