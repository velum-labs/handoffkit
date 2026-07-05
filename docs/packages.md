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
| `@fusionkit/cli` | `fusionkit` command line workflows for init, local models, harness launchers, sessions, config, prompts, and fusion. | `packages/cli/src/cli.ts`, `packages/cli/src/commands` |
| `@fusionkit/handoff` | Continuation SDK: checkpoints, `continueIn`, parallel fan-out, review, pull, tools, model routing, and trace logs. | `legacy/packages/handoff/src/handoff.ts` |
| `@fusionkit/adapter-ai-sdk` | Product-local AI SDK utilities, worktree agents, local model adapters, and managed MLX helpers. | `packages/adapter-ai-sdk/src/index.ts` |
| `@fusionkit/adapter-compute` | ComputeSDK-shaped sandbox surface backed by governed runner sessions. | `legacy/packages/adapter-compute/src/sandbox.ts` |
| `@fusionkit/model-gateway` | Local-model gateway exposing harness wire dialects over OpenAI-compatible local models. | `packages/model-gateway/src/index.ts` |

## Session and harness packages

| Package | Responsibility | Start with |
| --- | --- | --- |
| `@fusionkit/session-hermetic` | just-bash virtual filesystem backend with interpreter-enforced egress and no real process/socket escape path. | `legacy/packages/session-hermetic/src/index.ts` |
| `@fusionkit/session-vercel-sandbox` | Firecracker microVM backend through Vercel Sandbox with domain egress policy. | `legacy/packages/session-vercel-sandbox/src/index.ts` |
| `@fusionkit/session-harness` | AI SDK harness bindings for vendor coding agents in governed sessions. | `legacy/packages/session-harness/src/index.ts` |
| `@fusionkit/ensemble` | FusionKit runtime kernel, typed operator graphs, schedulers, workflow recipes, harness-agnostic model-fusion runner, artifacts, worktrees, dashboards, judge synthesis, and protocol records. | `packages/ensemble/src/index.ts`, `packages/ensemble/src/kernel.ts`, `packages/ensemble/src/workflows.ts` |

## Support packages

| Package | Responsibility | Start with |
| --- | --- | --- |
| `@fusionkit/testkit` | In-process plane/runner stacks and Git fixtures for tests and demos. | `packages/testkit/src/index.ts` |
| `@fusionkit/example-utils` | Shared demo manifest parsing, narration, and live-model helpers. | `packages/example-utils/src/index.ts` |

## Python packages

| Package | Responsibility | Start with |
| --- | --- | --- |
| `uniroute` | NumPy implementation of dynamic-pool UniRoute model routing. | `python/uniroute/README.md` |
| `uniroute-mlx` | OpenAI-compatible and MLX-serving bridge for evaluating and serving routed local models. | `python/uniroute-mlx/README.md` |
