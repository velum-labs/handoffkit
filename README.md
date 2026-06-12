# Warrant (working name)

The governed execution and provenance plane for AI agents.

Run any vendor's agent — Claude Code, Codex, Cursor CLI — on a runtime you control, under policy, with a signed receipt proving what it saw, ran, changed, and was given.

The two core objects are the **run contract** (a signed authorization to execute under stated conditions) and the **receipt** (a signed, offline-verifiable record of what actually happened). Continuation — handing local work to a governed runner and pulling it back — is built from those same primitives and shipped here as the **handoff SDK**.

## Status

The kernel, control plane, runner, control panel UI, handoff SDK, AI SDK and compute adapters, CLI, demo series, and Docker deployment are implemented. The control plane is hardened: durable transactional SQLite storage, atomic run claims, durable replay protection, role-based principal auth with rotation/revocation, IdP-backed approvals, request validation, rate limiting, master-key at-rest encryption, retention/GC, and structured logging + metrics (see "Hardening and operations" below). The protocol/verifier packages still use only Node built-ins, keeping the offline verifier maximally auditable; other packages use trusted, exact-pinned third-party dependencies (see "Dependency policy"). The validation gate in the spec (design-partner interviews) still governs go-to-market.

## Repository layout

| Package | What it is |
| --- | --- |
| [`@warrant/protocol`](packages/protocol) | The open data contracts (`warrant.contract.v1`, `receipt.v1`, `event.v1`, `manifest.v1`, `policy.v1`, `checkpoint.v1`, `envelope.v1`), the wire API types, and the primitives to sign, hash-chain, and verify them offline. |
| [`@warrant/workspace`](packages/workspace) | Git workspace capture (with provable secret-pattern denial), session materialization, output collection, and divergence-safe pull. |
| [`@warrant/plane`](packages/plane) | Control plane: contracts, policy evaluation, role-based principal auth, IdP-backed approvals, receipt countersignature, secret broker, durable SQLite storage, rate limiting, retention/GC, metrics, audit export — and the control panel UI at `/ui/`. |
| [`@warrant/runner`](packages/runner) | Outbound-only runner: claims contracts, materializes workspaces, runs agent harnesses in governed sessions with deny-by-default egress, signs receipts. Pluggable session-isolation backends. |
| [`@warrant/session-hermetic`](packages/session-hermetic) | Hermetic session backend: a simulated bash interpreter ([just-bash](https://github.com/vercel-labs/just-bash)) with a virtual filesystem and interpreter-enforced egress. No real process or socket to escape with. |
| [`@warrant/session-vercel-sandbox`](packages/session-vercel-sandbox) | Vercel Sandbox session backend: each session runs in a Firecracker microVM with VM-level isolation and domain egress policy. Experimental, integration-gated. |
| [`@warrant/sdk`](packages/sdk) | Thin client over the plane API plus offline receipt verification. |
| [`@warrant/handoff`](packages/handoff) | The continuation SDK: `handoff(...)`, `checkpoint`, `continueIn`, `parallel`, `review`, `pull` — typed descriptors, fail-closed planning, full provenance. |
| [`@warrant/adapter-ai-sdk`](packages/adapter-ai-sdk) | AI SDK adapter for app-owned loops: `remoteTools(...)` returns AI SDK-compatible tools whose calls execute as signed contracts in governed sessions and return with receipts. |
| [`@warrant/adapter-compute`](packages/adapter-compute) | ComputeSDK-shaped compute surface: `sandbox.create()`, `runCommand`, `filesystem` — every command a governed run with a receipt. |
| [`@warrant/cli`](packages/cli) | The `warrant` CLI: the primary product surface. |
| [`@warrant/testkit`](packages/testkit) | In-process plane + runner stacks and git fixtures, shared by tests and demos. |
| [`examples/*`](examples) | Standalone example projects for the runnable demos (below). |
| [`uniroute`](python/uniroute) | Python (uv workspace member): UniRoute universal model routing, arXiv:2502.08773. |
| [`uniroute-mlx`](python/uniroute-mlx) | Python (uv workspace member): evaluate and fit UniRoute routers over OpenAI-compatible endpoints (mlx-lm, Ollama, cloud), exporting portable router cards consumed by `routedModel`. |

## Python workspace

Alongside the pnpm workspace, the repository is a [uv](https://docs.astral.sh/uv/) monorepo for its Python side: the root `pyproject.toml` declares a virtual workspace whose members live under `python/*` and share the committed `uv.lock`.

```sh
uv sync --all-packages                 # one .venv for every Python package
uv run pytest python/uniroute/tests   # test a member
uv run uniroute-demo                   # run a member's entry point
```

## Quickstart

Prerequisites: Node >= 22 and git. The exact pnpm version is pinned via Corepack — no global install needed:

```sh
corepack enable          # one-time; activates the pinned pnpm from package.json
pnpm install             # links all workspace packages from the frozen lockfile
pnpm build               # tsc -b builds every package in dependency order
pnpm verify              # repo checks + build + the full test suite
```

```sh

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

## Standalone examples

Each demo is now its own workspace project under `examples/`. They remain self-contained (in-process plane + runner + built-in mock agent; no vendor CLIs or API keys) and narrate what they prove:

```sh
pnpm demo           # list standalone examples
pnpm demo 01        # run one example project
pnpm demo all       # run every non-interactive example
```

| # | Demo | What it proves |
| --- | --- | --- |
| 01 | [Governed run](examples/governed-run) | Signed contract → governed session → receipt answering the five questions, verified offline. |
| 02 | [Dry run](examples/dry-run) | The complete disclosure report — including provably denied `.env`/key captures — with nothing moved. |
| 03 | [Consent + secrets](examples/consent-secrets) | A secret-releasing run blocks on human approval; the value is injected at runtime and appears nowhere in any artifact. |
| 04 | [Egress policy](examples/egress-policy) | Fail-closed network policy at contract time, deny-by-default enforcement and evidence at the session boundary. |
| 05 | [Offline verification](examples/offline-verify) | Tampered event chains and forged receipts are detected with no trust in the plane. |
| 06 | [Handoff](examples/handoff) | `h.continueIn(targets.pool("eng-prod"), …)`: checkpoint, envelope, governed run, trace, receipt, divergence-safe pull. |
| 07 | [Parallel fan-out](examples/parallel-fanout) | One checkpoint forked into isolated attempts, reviewed with typed deterministic strategies; every attempt keeps its receipt. |
| 08 | [Control panel](examples/control-panel) | Boots a seeded plane + runner and leaves the UI up for you to explore (interactive). |
| 09 | [AI SDK loop](examples/ai-sdk-loop) | An ordinary `generateText` loop whose tool calls execute in governed sessions and return with verified receipts. |
| 10 | [Compute sandbox](examples/compute-sandbox) | The ComputeSDK shape (`create`, `runCommand`, `filesystem`) over governed sessions, with continuity through the workspace. |
| 11 | [Golden interface](examples/golden-interface) | `h.tools` + `h.needs` + `h.continueIn` + `h.compute` + `h.summary` in one context, with the tool journal carried across the boundary. |
| 12 | [Model escalation](examples/model-escalation) | `h.model` starts local, escalates to cloud on deterministic conditions, explains every routing decision, and gates `h.needs`. |
| 13 | [Hermetic session](examples/hermetic-session) | The `command` harness runs inside a bash interpreter with a virtual filesystem and interpreter-enforced egress; the receipt records `isolation: hermetic`. |

## Using real models

The AI SDK demos (09, 11, 12) run with scripted mock models by default so the series is deterministic and key-free in CI. Point them at real models through any OpenAI-compatible endpoint and the same demos run live — the governance (contracts, sessions, receipts) is identical in both modes:

```sh
# real local model (Ollama, LM Studio, …)
export WARRANT_DEMO_LOCAL_URL=http://localhost:11434/v1
export WARRANT_DEMO_LOCAL_MODEL=qwen3:8b

# real cloud model (OpenAI, a gateway, OpenRouter, …)
export OPENAI_API_KEY=sk-...                       # or WARRANT_DEMO_CLOUD_API_KEY
export WARRANT_DEMO_CLOUD_MODEL=gpt-4o-mini        # named explicitly, no silent default
# export WARRANT_DEMO_CLOUD_URL=https://api.openai.com/v1   (default)

pnpm demo 09   # a real model drives generateText; its tool calls run in governed sessions
pnpm demo 12   # real local-first escalation: local model → cloud model, decision trace included
```

And the core product path has always been real models: the vendor agent harnesses wrap the actual CLIs, with API keys released by the secret broker — never present in prompts, contracts, logs, or receipts:

```sh
# org policy: make the key releasable and the API host reachable, then:
warrant secrets set ANTHROPIC_API_KEY sk-ant-...
warrant run --agent claude-code --secret ANTHROPIC_API_KEY \
  --allow-host api.anthropic.com "fix the flaky auth test and run the suite"
```

### Managed MLX: Warrant owns the model server

On Apple Silicon, `mlxServer(...)` from `@warrant/adapter-ai-sdk` owns the whole local-model stack rather than pointing at a server you run by hand. It provisions a dedicated directory (default `~/.warrant/mlx`) containing a private Python venv with [mlx-lm](https://pypi.org/project/mlx-lm/) at an exact pin, an env manifest, and a contained Hugging Face model cache — then boots `mlx_lm server` from that env's own interpreter on the first model call, and scales it to zero after an idle period. The next call transparently restarts it.

Provisioning prefers [uv](https://docs.astral.sh/uv/) when available (an explicit path, `WARRANT_UV`, or PATH discovery): installs are an order of magnitude faster, and uv supplies its own managed CPython at a pinned version — removing even the system-python requirement — with its caches and interpreters contained inside the owned directory. Without uv it falls back to stdlib `python3 -m venv` + pip, so uv is an upgrade, never a dependency. The manifest records which toolchain built the env.

```ts
import { handoffModel, mlxServer } from "@warrant/adapter-ai-sdk";

const local = mlxServer({
  model: "mlx-community/Qwen3-4B-4bit",
  idleShutdownMs: 5 * 60 * 1000 // scale to zero after 5 idle minutes
});

const model = handoffModel({ local, cloud: openai("gpt-5.5") });
// First call: provisions the env (once), spawns the server, waits for
// health. Idle: the process is stopped. Crash or wrong platform: the
// call escalates to cloud, honestly recorded in the routing trace.
```

The footprint is one inspectable directory: `local.env.info()` reports the manifest and disk usage, `local.env.verify()` checks the env is intact, and `local.env.destroy()` removes everything — venv, weights, logs, uv caches. The mlx-lm pin (`MLX_LM_PIN`) and the Python version requested from uv (`PYTHON_PIN`) follow the same trusted-pin policy as the npm allowlist: exact versions, bumped only as reviewed changes. The generic layer (`managedModelServer(...)`) accepts any `prepare()` hook, so the same lazy-start/scale-to-zero lifecycle can manage other OpenAI-compatible servers.

Passing `structured: true` to `mlxServer(...)` additionally installs the in-repo [mlx-lm-structured](python/mlx-lm-structured/README.md) overlay (plus [outlines-core](https://pypi.org/project/outlines-core/) at an exact pin) into the owned env and boots the server through its entry point. The stock mlx-lm server silently ignores `response_format`; with the overlay, JSON schema / regex / choice constraints are enforced by masking logits with a compiled FSM, so the AI SDK's structured output modes (`generateObject`, `responseFormat: json`) produce schema-valid output from the local model.

### UniRoute: learned routing over a model pool

Beyond the two-model `handoffModel` escalation, `routedModel(...)` routes each call across a *pool* of candidates by predicted correctness (UniRoute, [arXiv:2502.08773](https://arxiv.org/abs/2502.08773)). The router is fitted offline by the Python [`uniroute`](python/uniroute)/[`uniroute-mlx`](python/uniroute-mlx) workspace packages and frozen into a portable router card (`uniroute.router.v1` JSON); onboarding a new model is one validation pass, never a retrain.

```ts
import { loadRouterCard, mlxServer, routedModel } from "@warrant/adapter-ai-sdk";

const card = loadRouterCard(JSON.parse(await readFile("router-card.json", "utf8")));
const model = routedModel({
  card,
  candidates: {
    "mlx-community/Qwen3-1.7B-4bit": mlxServer({ model: "mlx-community/Qwen3-1.7B-4bit" }),
    "mlx-community/Qwen3-8B-4bit": mlxServer({ model: "mlx-community/Qwen3-8B-4bit" }),
    "gpt-5.5": openai("gpt-5.5")
  },
  embed: embedWithTheCardsEmbedder // must match card.embedder.model
});
// Each call: embed → cluster → argmin(predicted error + λ·cost) → one model
// runs. A failed call falls back to the next-best candidate, honestly
// reported via onDecision (withRoutedModel wires this into h.trace()).
```

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

### The golden interface

The predecessor spec's golden shape, implemented to the extent the current spec permits — and honest about the one piece it omits:

```ts
import { generateText } from "ai";
import { agents, handoff, localFirst, targets } from "@warrant/handoff";
import { withCompute } from "@warrant/adapter-compute";

const h = withCompute(
  handoff({ workspace: ".", plane, agent: agents.claudeCode(), policy: localFirst({ allowPools: ["eng-prod"] }) }),
  { pool: "eng-prod" }
);

const result = await generateText({
  model: yourModel,                 // your model, your loop
  prompt: "plan the refactor",
  tools: h.tools({ search, read }) // your tools, journaled as semantic state
});

if (h.needs(targets.pool("eng-prod"))) {
  await h.continueIn(targets.pool("eng-prod"), { task: "apply the plan and run tests" });
}

await h.compute.sandbox.create();   // ComputeSDK-shaped surface, same context
console.log(await h.summary());     // recomputed story: tools, checkpoints, runs, pulls
```

- `h.tools(...)` wraps any AI SDK-shaped toolset: calls execute locally and are journaled (`warrant.tooljournal.v1`); the journal travels as content-addressed semantic state in the next checkpoint, pinned via the envelope inside the signed contract.
- `h.model` (via `withModel(h, { local, cloud })` from `@warrant/adapter-ai-sdk`) is an AI SDK-compatible model that starts local and escalates to cloud under deterministic, explainable conditions — a local failure, a classified context overflow, a prompt-size threshold — with every routing decision recorded as a `model.routed` trace event. Honest limits: escalation happens *between* calls; there is no mid-generation handoff.
- `h.needs(target)` is a pure, deterministic check: the target must be allowed by policy, and — when the policy declares `continueWhen: [triggers.…]` — at least one trigger must fire against observable state (`triggers.userRequested()`, `toolFailed()`, `slowTools({ thresholdMs })`, `modelEscalated()`). `h.requestContinuation(reason)` is the explicit user gesture.
- `h.stream(runs)` yields a live, typed event stream (status transitions, every hash-chained event, `artifact.ready`, terminals) across any set of runs.
- `h.parallel(..., { isolate: branch() })` and `run.pull({ isolate: branch() })` force results onto dedicated branches; the default stays divergence-safe auto.
- `h.review(runs, { choose: reviewStrategies.testsPassSmallestDiff() })` compares attempts on evidence-derived scorecards (harness exit, diff size, files changed, duration, blocked egress, secrets released).
- Every run carries `ContinueResult` parity: `tier`, `explanation` (the planner's reasons), `url` (control panel deep link), and `auditUrl`; checkpoints form a lineage (`parent`), listable via `h.checkpoints()`.
- `defineHandoffConfig({...})` registers provider-style defaults once, so app code can be just `handoff({ workspace: "." })`.

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

## Session isolation

How the runner isolates the agent session is pluggable, requested per run (`--isolation`, or `session:` in the handoff SDK), and recorded honestly in every receipt (`runner.isolation`):

| Tier | Backend | Isolation | Harnesses | Status |
| --- | --- | --- | --- | --- |
| `process` | built-in | child process, scrubbed env, egress proxy (process-level — a binary can ignore proxy vars; every attempt is still recorded) | all | default |
| `hermetic` | `@warrant/session-hermetic` | simulated bash interpreter + virtual filesystem; egress enforced by the interpreter (no socket exists for denied hosts) | `command` only (no real OS) | implemented, tested |
| `vercel-sandbox` | `@warrant/session-vercel-sandbox` | Firecracker microVM, VM-level isolation, domain egress policy | all but the test mock | experimental, integration-gated |

```sh
warrant run --agent command --isolation hermetic "awk -F, 'NR>1{s+=$2}END{print s}' orders.csv > total.txt"
```

The two stronger backends are injected into the runner so the trust-critical kernel stays dependency-free:

```ts
import { Runner } from "@warrant/runner";
import { hermeticBackend } from "@warrant/session-hermetic";
import { vercelSandboxBackend } from "@warrant/session-vercel-sandbox";

new Runner({ planeUrl, pool, enrollToken, backends: [hermeticBackend(), vercelSandboxBackend()] });
```

This is the execution substrate the spec places *below* Warrant ("E2B, Modal, Daytona, Vercel Sandbox, local Docker, and customer VPCs sit below"): Warrant owns the contract, policy, secret release, and receipt; the backend owns only how the session is isolated.

## Hardening and operations

The control plane is built for a single-node production deployment, with the security-critical paths hardened:

- Durable, transactional storage (`node:sqlite`, WAL) behind a `PlaneStore` interface. Run claims are an atomic compare-and-set (no double-claim), and the claim-completion nonce ledger is a durable UNIQUE-constrained table, so replay protection survives restarts.
- Role-based identity: principals with roles (`admin`/`requester`/`approver`/`enroller`), per-principal API keys that can be issued, rotated, and revoked, and capability-gated routes. Runner enrollment uses single-use expiring tokens (or a revocable bootstrap enroller credential).
- IdP-backed approvals: an approval can carry an IdP-issued JWT, verified against configured JWKS, so consent is attributable to a real subject.
- Boundary validation (`zod`) with structured 400s, plus per-principal/per-IP token-bucket rate limiting and auth-failure backoff.
- At-rest encryption: the org signing key and the secret store are sealed (scrypt + AES-256-GCM) with a master key supplied via `WARRANT_MASTER_KEY` (or a generated 0600 key file). No key material lives in `config.json`.
- Retention and GC: a sweeper enforces the `RetentionPolicy` and reference-counted blob GC; `pino` structured logging (set `LOG_LEVEL`), metrics counters, and `/v1/ready` + `/v1/metrics`.

Operational notes:

- Set `WARRANT_MASTER_KEY` (e.g. `openssl rand -hex 32`) in any real deployment; the same value must be present wherever the plane or a CLI loads the home (the runner shares it to read the home config). `docker compose` injects a labeled dev default you should override.
- Performance budgets from spec section 8.4 are asserted by `pnpm bench` (corpus size via `WARRANT_BENCH_FILES`).
- Manage principals and enrollment from the CLI/API: `POST /v1/principals`, `POST /v1/enroll-tokens`, `GET /v1/metrics`.

What remains explicitly out of scope: true multi-node HA (the `PlaneStore` interface is the seam for a Postgres adapter), real TEE attestation (still labeled `mock`), and a full OIDC login UI (only IdP assertion verification is implemented).

## Dependency policy

Third-party dependencies are allowed in any package, but only trusted, exact-pinned versions on the explicit allowlist in `scripts/check-repo.mjs`. There is no zero-dependency rule; trust comes from pinning reviewed versions plus the `.npmrc` supply-chain controls (`save-exact`, `ignore-scripts`, `verify-store-integrity`, frozen lockfile installs, and a 24-hour `minimum-release-age` against fresh-release attacks), not from the absence of dependencies. The protocol/sdk/workspace packages still happen to use only Node built-ins, which keeps the offline verifier maximally auditable — a property, not a gate. Bumping a dependency means updating the allowlist pin, which is the review checkpoint.

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
pnpm test            # unit + integration: protocol, policy, workspace, plane API/UI,
                     # plane hardening (atomic claim, replay, auth/roles, rate limit,
                     # sealing, retention), planner, handoff e2e, CLI e2e, examples
pnpm demo all        # the standalone examples double as an executable acceptance suite
pnpm bench           # asserts the spec section 8.4 performance budgets
```

CI runs the suite, the standalone examples, the performance benchmark, and a Docker Compose smoke test (build, boot, seed, hit the API, readiness, metrics, and control panel).

## Current artifacts

- [Governed agent execution plane spec](spec/2026-06-11-governed-agent-execution-plane-spec.md)

## Superseded

- [Local-first handoff platform SDK spec](spec/2026-06-11-local-first-handoff-platform-spec.md) — the predecessor "HandoffKit" artifact, retained for record. Its positioning ("The coordination layer for hybrid distributed AI compute.") is superseded: continuation and handoff are now demos of the primitives — implemented here as `@warrant/handoff` — not the product.
