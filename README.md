# Warrant (working name)

The governed execution and provenance plane for AI agents.

Run any vendor's agent — Claude Code, Codex, Cursor CLI — on a runtime you control, under policy, with a signed receipt proving what it saw, ran, changed, and was given.

The two core objects are the **run contract** (a signed authorization to execute under stated conditions) and the **receipt** (a signed, offline-verifiable record of what actually happened). Continuation — handing local work to a governed runner and pulling it back — is built from those same primitives and shipped here as the **handoff SDK**.

## Status

The kernel, control plane, runner, control panel UI, handoff SDK, AI SDK and compute adapters, CLI, demo series, and Docker deployment are implemented. The trust-critical kernel runs on Node built-ins only; adapters may use trusted, exact-pinned third-party dependencies (see "Dependency policy" below). The validation gate in the spec (design-partner interviews) still governs go-to-market.

## Repository layout

| Package | What it is |
| --- | --- |
| [`@warrant/protocol`](packages/protocol) | The open data contracts (`warrant.contract.v1`, `receipt.v1`, `event.v1`, `manifest.v1`, `policy.v1`, `checkpoint.v1`, `envelope.v1`), the wire API types, and the primitives to sign, hash-chain, and verify them offline. |
| [`@warrant/workspace`](packages/workspace) | Git workspace capture (with provable secret-pattern denial), session materialization, output collection, and divergence-safe pull. |
| [`@warrant/plane`](packages/plane) | Control plane: contracts, policy evaluation, approvals, receipt countersignature, secret broker, audit export — and the control panel UI it serves at `/ui/`. |
| [`@warrant/runner`](packages/runner) | Outbound-only runner: claims contracts, materializes workspaces, runs agent harnesses in governed sessions with deny-by-default egress, signs receipts. |
| [`@warrant/sdk`](packages/sdk) | Thin client over the plane API plus offline receipt verification. |
| [`@warrant/handoff`](packages/handoff) | The continuation SDK: `handoff(...)`, `checkpoint`, `continueIn`, `parallel`, `review`, `pull` — typed descriptors, fail-closed planning, full provenance. |
| [`@warrant/adapter-ai-sdk`](packages/adapter-ai-sdk) | AI SDK adapter for app-owned loops: `remoteTools(...)` returns AI SDK-compatible tools whose calls execute as signed contracts in governed sessions and return with receipts. |
| [`@warrant/adapter-compute`](packages/adapter-compute) | ComputeSDK-shaped compute surface: `sandbox.create()`, `runCommand`, `filesystem` — every command a governed run with a receipt. |
| [`@warrant/cli`](packages/cli) | The `warrant` CLI: the primary product surface. |
| [`@warrant/testkit`](packages/testkit) | In-process plane + runner stacks and git fixtures, shared by tests and demos. |
| [`examples/demos`](examples/demos) | The runnable demo series (below). |

## Quickstart

```sh
pnpm install && pnpm build

# one-time: org keys, config, policy
node packages/cli/dist/index.js init

# terminal 1: control plane + control panel
node packages/cli/dist/index.js plane start      # http://127.0.0.1:7172/ui/

# terminal 2: an outbound-only runner (your machine is the "customer infra")
node packages/cli/dist/index.js runner start --pool default

# terminal 3: a governed run in any git repo
cd your-repo
node ../path/to/packages/cli/dist/index.js run --agent mock "try the kernel"      # no API keys needed
node ../path/to/packages/cli/dist/index.js run --agent claude-code "fix the bug"  # wraps the real CLI

# what would move, without moving anything
node packages/cli/dist/index.js run --agent mock --dry-run "probe"

# the product: one screen, five questions — then prove it offline
node packages/cli/dist/index.js receipt run_...
node packages/cli/dist/index.js bundle run_... --out bundle.json
node packages/cli/dist/index.js verify bundle.json

# continuation, built from the same primitives
node packages/cli/dist/index.js continue --agent mock --reason "laptop going offline" "finish the refactor"
node packages/cli/dist/index.js pull run_...
```

### Docker

One command boots the plane (with the control panel), a runner, and a seeder that fills the panel with showcase runs:

```sh
docker compose up --build
# open http://localhost:7172/ui/
docker compose exec plane warrant ui      # prints the control panel login token
docker compose exec plane warrant runs    # or drive it from the CLI
```

### Control panel

`warrant plane start` serves a dependency-free control panel at `/ui/`: live run list, hash-chained event timelines, one-screen receipts (the five questions), consent approvals, run cancellation, runner inventory, the content-addressed policy snapshot, bundle download, and audit JSONL export. Sign in with the admin token from `warrant ui`.

## Demo series

Every demo is self-contained (in-process plane + runner + built-in mock agent; no vendor CLIs or API keys) and narrates what it proves:

```sh
pnpm demo           # list
pnpm demo 01        # run one
pnpm demo all       # run the whole series (skips interactive demos)
```

| # | Demo | What it proves |
| --- | --- | --- |
| 01 | Governed run | Signed contract → governed session → receipt answering the five questions, verified offline. |
| 02 | Dry run | The complete disclosure report — including provably denied `.env`/key captures — with nothing moved. |
| 03 | Consent + secrets | A secret-releasing run blocks on human approval; the value is injected at runtime and appears nowhere in any artifact. |
| 04 | Egress policy | Fail-closed network policy at contract time, deny-by-default enforcement and evidence at the session boundary. |
| 05 | Offline verification | Tampered event chains and forged receipts are detected with no trust in the plane. |
| 06 | Handoff | `h.continueIn(targets.pool("eng-prod"), …)`: checkpoint, envelope, governed run, trace, receipt, divergence-safe pull. |
| 07 | Parallel fan-out | One checkpoint forked into isolated attempts, reviewed with typed deterministic strategies; every attempt keeps its receipt. |
| 08 | Control panel | Boots a seeded plane + runner and leaves the UI up for you to explore (interactive). |
| 09 | AI SDK loop | An ordinary `generateText` loop whose tool calls execute in governed sessions and return with verified receipts. |
| 10 | Compute sandbox | The ComputeSDK shape (`create`, `runCommand`, `filesystem`) over governed sessions, with continuity through the workspace. |

## The handoff SDK

```ts
import { agents, handoff, localFirst, reviewStrategies, targets } from "@warrant/handoff";

const h = handoff({
  workspace: ".",
  plane: { url: planeUrl, adminToken },
  agent: agents.claudeCode(),                       // or agents.codex(), agents.mock()
  policy: localFirst({ allowPools: ["eng-prod"], maxParallelRuns: 4 })
});

// what would move? (a security feature: moves nothing)
const { report } = await h.dryRun(targets.pool("eng-prod"), { task: "run the suite" });

// one gesture: checkpoint → content-addressed envelope → signed contract → governed run
const run = await h.continueIn(targets.pool("eng-prod"), {
  task: "finish the refactor and run the tests",
  reason: "laptop going offline",
  transcript: sessionTranscript
});
await run.wait();
await run.pull();                                    // divergence-safe: applies or lands on a branch

// fan-out is topology, not a tournament
const runs = await h.parallel(["fix A", "fix B", "fix C"], targets.pool("eng-prod"));
const review = await h.review(runs, { choose: reviewStrategies.smallestDiff() });
await review.chosen.run.pull();

console.log(h.trace());                              // every planning, envelope, run, and pull decision
```

Continuation is not a separate trust domain: the envelope is content-addressed, the signed run contract pins the envelope hash, the checkpoint appears in the hash-chained event log, and the result is an ordinary offline-verifiable receipt.

## App-owned loops: AI SDK and compute adapters

For applications that own their model loop, the adapters govern the execution boundary instead (spec §6.2 — supported, limited, honestly labeled: no durability claim attaches to the caller's loop, and there is no mid-generation continuation):

```ts
import { generateText } from "ai";
import { remoteTools } from "@warrant/adapter-ai-sdk";

const rt = remoteTools({ workspace: ".", plane, pool: "eng-prod" });
const result = await generateText({
  model: yourModel,            // your model, your loop
  tools: rt.tools,             // tool calls become signed contracts with receipts
  prompt: "run the tests and summarize the failures"
});
rt.calls();                    // [{ runId, contractHash, receiptVerified: true, … }]
```

```ts
import { governedCompute } from "@warrant/adapter-compute";

const compute = governedCompute({ workspace: ".", plane, pool: "eng-prod" });
const sandbox = await compute.sandbox.create();
await sandbox.filesystem.writeFile("task.md", task);
await sandbox.runCommand("npm test");               // a governed run with a receipt
sandbox.runs();                                      // evidence for every command
```

Each command runs in a fresh governed session materialized from the current workspace; continuity flows through the workspace's git history, and the receipts — not a long-lived remote process — are what persists.

## Dependency policy

Third-party dependencies are allowed, but only trusted, exact-pinned versions on the explicit allowlist in `scripts/check-repo.mjs`, and only in adapter and example packages. The trust-critical kernel — protocol, workspace, sdk, plane, runner, handoff, cli — stays on Node built-ins so receipts remain verifiable without trusting anyone's dependency tree. Reinforced by `.npmrc`: `save-exact`, `ignore-scripts`, `verify-store-integrity`, frozen lockfile installs, and a 24-hour `minimum-release-age` against fresh-release supply-chain attacks. Bumping a dependency requires updating the allowlist pin — that review step is the point.

## Thesis

AI work crosses trust boundaries — laptops, vendor clouds, customer VPCs, attested runtimes — and that shift is permanent. Vendors already own continuation *inside* their silos and give it away. What no vendor can ship is the cross-vendor answer to what their agents did: Anthropic will not audit Codex, and Cursor will not govern Claude Code.

The unowned layer is governed execution and provenance:

- execution of vendor harnesses, wrapped as-is, on customer-controlled runners
- policy decided before execution and enforced at the session boundary
- signed, hash-chained receipts portable across vendors and runtimes
- secret release that is brokered, scoped, and logged — never prompted
- offline verification that requires trusting no one, including us

## Product invariant

Every run must answer:

1. What moved?
2. Why did it move?
3. Who or what approved it?
4. Which runtime, model, tools, data, and secrets saw it?
5. How can the user resume, inspect, revoke, or reproduce it?

If the platform cannot answer those questions from a signed receipt, on one screen, without trusting the runtime that executed the work, it is just remote execution with branding.

## Testing

```sh
pnpm verify          # repo checks + build + the full test suite
pnpm test            # unit + integration: protocol, policy, workspace, plane API/UI, planner, handoff e2e, CLI e2e, demos
pnpm demo all        # the demo series doubles as an executable acceptance suite
```

CI runs the suite plus a Docker Compose smoke test (build, boot, seed, hit the API and control panel).

## Current artifacts

- [Governed agent execution plane spec](spec/2026-06-11-governed-agent-execution-plane-spec.md)

## Superseded

- [Local-first handoff platform SDK spec](spec/2026-06-11-local-first-handoff-platform-spec.md) — the predecessor "HandoffKit" artifact, retained for record. Its positioning ("The coordination layer for hybrid distributed AI compute.") is superseded: continuation and handoff are now demos of the primitives — implemented here as `@warrant/handoff` — not the product.
