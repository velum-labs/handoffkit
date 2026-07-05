# Apps and examples

This page documents the standalone apps and every example package in the repository. Use it when you need a runnable scenario, a local UI, a docs-site entry point, or a demo that proves a specific platform behavior.

The examples are not all part of the shipped FusionKit product path. Several demonstrate Warrant governance, sandbox, receipt, and handoff behavior that remains in the repository for compatibility and release reasons. The scope column below identifies the best mental model for each example.

## Standalone apps

### `apps/docs`

`apps/docs` is the public documentation site. It uses Next.js, React, Fumadocs, MDX, a generated OpenAPI bridge, and a Mermaid component. It is not part of the root pnpm workspace, so install and build it from its own directory.

Important files:

| File | Responsibility |
| --- | --- |
| `apps/docs/content/docs/` | User-facing documentation content. |
| `apps/docs/content/docs/meta.json` | Top-level Fumadocs navigation. |
| `apps/docs/source.config.ts` | Source configuration for MDX content. |
| `apps/docs/lib/source.ts` | Documentation source loader. |
| `apps/docs/lib/openapi.ts` | OpenAPI integration helpers. |
| `apps/docs/scripts/generate-openapi.ts` | Generates API material for the docs site. |
| `apps/docs/components/mermaid.tsx` | Mermaid rendering component. |
| `apps/docs/vercel.json` | Deployment configuration. |

Run it locally:

```bash
cd apps/docs
pnpm install
pnpm dev
```

Build it:

```bash
cd apps/docs
pnpm build
```

Update this app when public user-facing behavior changes, especially installation, quickstarts, CLI flags, concepts, self-hosting, or API contracts.

### `apps/scope`

`apps/scope` is the local observability companion for FusionKit traces, sessions, judge flow, and run inspection. It is also outside the root pnpm workspace.

Run or test it from its own directory:

```bash
cd apps/scope
pnpm install
pnpm test
```

Use this app when validating observability behavior, trace rendering, session inspection, or local debugging workflows. When trace event shapes change, update both the app and [Specs and APIs](specs-and-apis.md).

## Example execution model

Examples live under `examples/`, and most have a `src/run.ts` entry point. The root `scripts/demo.mjs` command uses `examples/manifest.json` to run non-interactive demos.

Build before running examples:

```bash
pnpm build
```

Run all configured demos:

```bash
pnpm demo all
```

Run a single demo by name:

```bash
pnpm demo governed-run
pnpm demo runtime-kernel
```

## FusionKit product examples

### `examples/runtime-kernel`

Scope: FusionKit runtime-kernel workflows.

This example demonstrates composing runtime-kernel workflows and executing them through the TypeScript kernel machinery. It is the best example to read when learning how `GraphBuilder`, operators, scheduler behavior, and workflow recipes fit together.

Run:

```bash
pnpm build
pnpm demo runtime-kernel
```

Expected value: the output should show a successful workflow execution with typed artifacts and a deterministic result. If this example fails after a kernel change, inspect graph validation, operator inputs, artifact type names, and scheduler assumptions.

### `examples/mlx`

Scope: FusionKit local model and MLX smoke testing.

This example exercises the owned MLX server path on Apple Silicon. It is useful for validating local model startup, AI SDK adapter integration, and the local generation path.

Run:

```bash
pnpm build
pnpm demo mlx
```

Expected value: on supported Apple Silicon machines, the example starts the local model path and performs a generation call. On unsupported machines, the product path should fail clearly and point users to cloud provider usage.

### `examples/bench`

Scope: benchmark and performance budget demonstration.

This example is an executable performance-budget benchmark for repository examples. Use it when validating that example-level measurements still run and report useful timing data.

Run:

```bash
pnpm build
pnpm demo bench
```

Expected value: the example should print benchmark measurements and exit successfully. If it fails, inspect environment assumptions and whether compiled example outputs exist.

## Governance and receipt examples

### `legacy/examples/governed-run`

Scope: Warrant governed execution.

This example demonstrates a governed run and an offline-verifiable receipt. It exercises the plane, runner, protocol contracts, workspace capture, and receipt verification story.

Run:

```bash
pnpm build
pnpm demo governed-run
```

Expected value: the demo should create an authorized run, execute it through the configured backend, and show receipt verification. Use it when changing contract signing, receipt bundles, runner behavior, or plane claim flow.

### `legacy/examples/dry-run`

Scope: Warrant policy and disclosure preview.

This example shows the dry-run disclosure path before execution. It is useful when changing policy evaluation, disclosure reporting, or approval flows.

Run:

```bash
pnpm build
pnpm demo dry-run
```

Expected value: the example should show what would be disclosed or executed without performing the final governed action.

### `legacy/examples/offline-verify`

Scope: receipt tamper evidence.

This example proves that receipts can be verified offline and that tampering is detected. It exercises protocol hashing, signing, chain verification, and receipt bundle checks.

Run:

```bash
pnpm build
pnpm demo offline-verify
```

Expected value: the valid receipt should verify, and the tampered receipt should fail verification.

### `legacy/examples/consent-secrets`

Scope: consent-gated secret release.

This example demonstrates how secret access is mediated by policy and approval. It is useful when changing secret scopes, consent rules, disclosure modes, or plane secret storage.

Run:

```bash
pnpm build
pnpm demo consent-secrets
```

Expected value: the example should show secret release only after the required consent path is satisfied.

### `legacy/examples/egress-policy`

Scope: deny-by-default network policy.

This example demonstrates network policy enforcement. It is relevant to the plane, runner, hermetic backend, Vercel Sandbox backend, and network policy conversion helpers.

Run:

```bash
pnpm build
pnpm demo egress-policy
```

Expected value: allowed destinations should succeed, denied destinations should fail closed, and the evidence should describe the network decision.

## Handoff and orchestration examples

### `legacy/examples/handoff`

Scope: continuation handoff.

This example demonstrates handing local work to a governed runner and pulling results back. It is the first example to inspect when changing `@fusionkit/handoff`, workspace capture, continuation envelopes, or output collection.

Run:

```bash
pnpm build
pnpm demo handoff
```

Expected value: the demo should create a handoff, execute it, and collect results with a verifiable path back to the request.

### `legacy/examples/parallel-fanout`

Scope: parallel continuation and review.

This example demonstrates fan-out across multiple continuations and a review step. It is useful when changing review strategies, branch isolation, scoring, or continuation aggregation.

Run:

```bash
pnpm build
pnpm demo parallel-fanout
```

Expected value: multiple candidate continuations should be created, reviewed, and summarized.

### `legacy/examples/model-escalation`

Scope: deterministic model routing.

This example demonstrates a local-to-cloud escalation policy. It is useful for adapter and model-routing changes where deterministic fallback behavior matters.

Run:

```bash
pnpm build
pnpm demo model-escalation
```

Expected value: the example should show a lower-cost or local model path escalating to a higher-capability model under the configured condition.

### `legacy/examples/ai-sdk-loop`

Scope: app-owned AI SDK loop with governed remote tools.

This example demonstrates integrating governed tools into an application-owned AI SDK loop. It is relevant to `@fusionkit/adapter-ai-sdk`, remote tools, tool result handling, and receipts.

Run:

```bash
pnpm build
pnpm demo ai-sdk-loop
```

Expected value: the loop should call governed tools and report receipt or evidence metadata for those calls.

### `legacy/examples/swarm`

Scope: governed swarm orchestration.

This example demonstrates a cloud orchestrator harness driving a governed swarm of local workers. It includes a terminal cockpit and is more complex than the simple examples.

Run:

```bash
pnpm build
pnpm demo swarm
```

Expected value: the orchestrator should coordinate worker tasks and expose enough progress to inspect the flow. If the environment lacks required interactive capabilities, use the source as an architecture example rather than a CI smoke test.

## Sandbox and session examples

### `legacy/examples/compute-sandbox`

Scope: ComputeSDK-shaped sandbox.

This example demonstrates `@fusionkit/adapter-compute`, where sandbox creation, command execution, and filesystem access are backed by governed runner sessions.

Run:

```bash
pnpm build
pnpm demo compute-sandbox
```

Expected value: sandbox operations should execute through the governed session abstraction and return evidence rather than raw local side effects.

### `legacy/examples/hermetic-session`

Scope: hermetic interpreter-backed sessions.

This example demonstrates the just-bash virtual filesystem backend. It is useful when changing interpreter behavior, virtual filesystem behavior, or network policy mapping.

Run:

```bash
pnpm build
pnpm demo hermetic-session
```

Expected value: commands should run inside the hermetic backend, and denied network or filesystem operations should fail according to policy.

### `legacy/examples/microvm-isolation-bench`

Scope: isolation timing benchmark.

This example measures local CI-safe isolation timings and optionally live Vercel Sandbox timings. It is useful when comparing hermetic and microVM isolation behavior or validating migration assumptions.

Run:

```bash
pnpm build
pnpm demo microvm-isolation-bench
```

Expected value: the benchmark should print timing measurements. Optional live Vercel Sandbox measurements require appropriate environment configuration.

## UI and seed examples

### `legacy/examples/control-panel`

Scope: interactive control panel exploration.

This example seeds data and starts an interactive control panel for exploring Warrant runs. Use it when changing plane UI behavior, seeded records, or audit views.

Run:

```bash
pnpm build
pnpm demo control-panel
```

Expected value: the example should produce or launch a control panel environment with seeded runs. Interactive behavior may require manual browser inspection.

### `legacy/examples/seed`

Scope: Docker and control-panel seeding.

This example supports showcase data creation for control-panel demos. It is a support package rather than a product quickstart.

Run:

```bash
pnpm build
pnpm demo seed
```

Expected value: seeded records or fixtures should be created for downstream UI exploration.

### `legacy/examples/golden-interface`

Scope: high-level Warrant interface.

This example demonstrates a golden interface over lower-level Warrant primitives. Use it when discussing desired ergonomics or validating that the primitive APIs can support a cleaner application-facing surface.

Run:

```bash
pnpm build
pnpm demo golden-interface
```

Expected value: the example should show the higher-level workflow while still producing governed evidence underneath.

## Example maintenance checklist

When adding an example, add a package under `examples/`, include a `src/run.ts` entry point when possible, update `examples/manifest.json`, add package scripts consistent with existing examples, document whether credentials or live services are required, and add the example to this page. If the example is intended for `pnpm demo all`, keep it deterministic and non-interactive.

When changing shared example utilities, run at least one example from each affected category. For product behavior, prioritize `runtime-kernel`, `mlx` when the platform supports it, and `bench`. For governance behavior, prioritize `governed-run`, `offline-verify`, `handoff`, and `egress-policy`.
