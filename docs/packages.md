# Package guide

The TypeScript workspace is managed by pnpm. Package entry points are generally
`packages/<name>/src/index.ts`; tests live next to source under `src/test`.

## Core packages

| Package | Responsibility | Start with |
| --- | --- | --- |
| `@warrant/protocol` | Contract, receipt, event, manifest, checkpoint, handoff, signing, hashing, and model-fusion protocol primitives. | `packages/protocol/src/index.ts` |
| `@warrant/workspace` | Git capture, secret-pattern denial, session materialization, output collection, and divergence-safe pull. | `packages/workspace/src/index.ts` |
| `@warrant/plane` | Control plane, policy, approvals, principals, secrets, receipt countersignature, SQLite store, metrics, audit export, and UI. | `packages/plane/src/plane.ts`, `packages/plane/src/server.ts` |
| `@warrant/runner` | Outbound claim loop, governed session execution, harness dispatch, egress enforcement integration, and runner receipts. | `packages/runner/src/runner.ts` |
| `@warrant/sdk` | Thin TypeScript client for the plane API plus offline receipt verification helpers. | `packages/sdk/src/index.ts` |

## Developer surfaces

| Package | Responsibility | Start with |
| --- | --- | --- |
| `@warrant/cli` | `warrant` command line workflows for init, plane, runner, runs, handoff, secrets, local models, and fusion. | `packages/cli/src/cli.ts`, `packages/cli/src/commands` |
| `@warrant/handoff` | Continuation SDK: checkpoints, `continueIn`, parallel fan-out, review, pull, tools, model routing, and trace logs. | `packages/handoff/src/handoff.ts` |
| `@warrant/adapter-ai-sdk` | AI SDK-compatible governed remote tools, swarm tools, local/cloud model handoff, routed models, and managed MLX. | `packages/adapter-ai-sdk/src/index.ts` |
| `@warrant/adapter-compute` | ComputeSDK-shaped sandbox surface backed by governed runner sessions. | `packages/adapter-compute/src/sandbox.ts` |
| `@warrant/model-gateway` | Local-model gateway exposing harness wire dialects over OpenAI-compatible local models. | `packages/model-gateway/src/index.ts` |

## Session and harness packages

| Package | Responsibility | Start with |
| --- | --- | --- |
| `@warrant/session-hermetic` | just-bash virtual filesystem backend with interpreter-enforced egress and no real process/socket escape path. | `packages/session-hermetic/src/index.ts` |
| `@warrant/session-vercel-sandbox` | Firecracker microVM backend through Vercel Sandbox with domain egress policy. | `packages/session-vercel-sandbox/src/index.ts` |
| `@warrant/session-harness` | AI SDK harness bindings for vendor coding agents in governed sessions. | `packages/session-harness/src/index.ts` |
| `@warrant/ensemble` | Harness-agnostic model-fusion runner, artifacts, worktrees, dashboards, judge synthesis, and protocol records. | `packages/ensemble/src/index.ts` |

## Support packages

| Package | Responsibility | Start with |
| --- | --- | --- |
| `@warrant/testkit` | In-process plane/runner stacks and Git fixtures for tests and demos. | `packages/testkit/src/index.ts` |
| `@warrant/example-utils` | Shared demo manifest parsing, narration, and live-model helpers. | `packages/example-utils/src/index.ts` |

## Python packages

| Package | Responsibility | Start with |
| --- | --- | --- |
| `uniroute` | NumPy implementation of dynamic-pool UniRoute model routing. | `python/uniroute/README.md` |
| `uniroute-mlx` | OpenAI-compatible and MLX-serving bridge for evaluating and serving routed local models. | `python/uniroute-mlx/README.md` |
