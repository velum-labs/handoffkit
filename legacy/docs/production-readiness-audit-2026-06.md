> Historical internal audit (2026-06-26). Retained for reference; contents are stale and do not describe the current product.

# Velum Labs — Production Readiness Audit

Deep cross-repo audit — 4 parallel read-only agents, quantitative metrics, file-level evidence. Date: **2026-06-26**.

Repos audited: `handoffkit` (flagship, `@fusionkit/cli` 0.7.4), `fusionkit` (PyPI `fusionkit` 0.7.1), `cursorkit` (`@velum-labs/cursorkit` 0.1.4), `mlx-lm` (Velum fork, unpublished), `fusionkit-sandbox` (demo fixture).

## Contents

1. [Executive summary](#1-executive-summary)
2. [Architecture — the two protocols, two planes](#2-architecture)
3. [Protocol — record catalog, hashing, pins](#3-protocol)
4. [Trust & provenance](#4-trust--provenance)
5. [handoffkit](#5-handoffkit)
6. [fusionkit](#6-fusionkit)
7. [cursorkit](#7-cursorkit)
8. [mlx-lm](#8-mlx-lm)
9. [Benchmarks](#9-benchmarks)
10. [Open-weight cloud benchmarking](#10-open-weight-cloud-benchmarking)
11. [Ecosystem](#11-ecosystem)
12. [Ranked blockers & remediation tiers](#12-ranked-blockers--remediation-tiers)
13. [Operator journey](#13-operator-journey)

---

## 1. Executive summary

### Readiness by launch target

| Launch target | Readiness |
|---|---|
| Design partner / self-hosted single-node | ~75% |
| npm / PyPI early adopters | ~68% |
| Commercial / enterprise GA | ~52% |
| Hosted / multi-tenant SaaS | ~30% |
| **Blended overall** | **~45%** |

### Readiness layers

| Layer | % |
|---|---|
| Engineering maturity | 72% |
| Enterprise production | 38% |
| Commercial / GTM | 12% |

### Three findings that reframe everything

1. **There are TWO protocols, not one.** The **Model Fusion Protocol** (`@velum-labs/model-fusion-protocol`, fusionkit-origin, 16 JSON-Schema records + OpenAPI 3.1 IDL) and the **Warrant Protocol** (`@fusionkit/protocol` in handoffkit, 7 `warrant.*` records). They interlock but are distinct.
2. **The shipped CLI does not match the docs.** handoffkit's README + `docs/cli.md` describe `warrant run/plane/runner/receipt/verify/bundle/continue/pull`, but `buildProgram()` only wires `ensemble / local / fusion / models / doctor`. `docs/cli.md:61` references a `commands/plane.ts` that does not exist. What 0.7.4 ships is the **fusion harness gateway**.
3. **Two provenance tiers with very different trust.** Signed ed25519 Warrant receipts vs. model-fusion records with hardcoded `producer_git_sha = "0".repeat(40)` and an **unauthenticated** scope ingest endpoint.

### Already shipping

`@fusionkit/cli@0.7.4`, `fusionkit@0.7.1`, `@velum-labs/cursorkit@0.1.4`, `@velum-labs/model-fusion-protocol@0.5.0`. Gaps are GTM, legal, ops, mlx distribution, and brand/docs drift — **not core engineering instability**.

### Release status (from `handoffkit/release/state.json`, last apply 2026-06-25)

| Unit | Desired | Published | Latest tag |
|---|---|---|---|
| `fusionkit-protocol` | 0.5.0 | 0.5.0 | `model-fusion-protocol-v0.5.0` |
| `fusionkit-pypi` | 0.7.1 | 0.7.1 | `fusionkit-v0.7.1` |
| `cursorkit` | 0.1.4 | 0.1.4 | `cursorkit-v0.1.4` |
| `handoffkit` | 0.7.4 | 0.7.4 | `handoffkit-v0.7.4` |
| `mlx-lm` | 0.31.3+structured.3 | **null (unpublished)** | null |

### Repo comparison

| Repo | LOC | Tests | Eng % | Enterprise % | Maturity /10 |
|---|---|---|---|---|---|
| handoffkit | ~50k TS | 155 files | 72 | 38 | 7 |
| fusionkit | Python | 232 (~83% cov) | 65 | 25 | 6.5 |
| cursorkit | 19.7k TS | 161 | 78 | 5 | 4 |
| mlx-lm | ~50k | 298 | 82 | 15 | 7 |

---

## 2. Architecture

### The two protocols

1. **Model Fusion Protocol** — `@velum-labs/model-fusion-protocol` (npm) / `velum-model-fusion-protocol` (PyPI). Source of truth in `fusionkit/spec/model-fusion-contract`. 16 JSON-Schema records + an OpenAPI 3.1 service IDL. The cross-repo **data** contract.
2. **Warrant Protocol** — `@fusionkit/protocol`, defined in `handoffkit/packages/protocol`. The `contract` / `receipt` / `event` / `warrant.*` governance plane. A different protocol that *also* re-exports the MF record types so the two interlock.

### Brand / identity split inside handoffkit

Root package is literally named `warrant` ("the governed execution and provenance plane for AI agents"). The npm scope is `@fusionkit/*`, the CLI binary is `fusionkit`, and the README quickstart says fusionkit ("real model fusion behind your coding agent"). Two genuinely different products share one tree and the `@fusionkit/protocol` kernel.

### The two planes

**Warrant control plane** (`@fusionkit/plane` + `runner` + `protocol`)
- Issues signed run contracts, evaluates policy, brokers secrets, countersigns receipts, serves the control-panel UI (`127.0.0.1:7172/ui`).
- Runner is **outbound-only**: polls, claims, materializes workspace, runs the harness in a session backend, signs runner receipts.
- Deps `jose`/`pino`/`zod`; `protocol`/`sdk`/`workspace` stay Node-builtins-only for auditability.

**Fusion harness gateway** (`@fusionkit/model-gateway` + `ensemble` + `apps/scope`)
- Lets unmodified Codex / Claude / Cursor use model fusion as backend. Each panel model runs through the **same harness** in its own git worktree.
- `FusionBackend` = "the judge streams a trajectory the user's harness executes." No apply/verify/repair — iteration is the harness's job.
- Dependency-injected `PanelRunner` so `model-gateway` does not depend on `ensemble`/`cli`.

### Native gateway front doors (dialects)

| Front door | Path | Used by |
|---|---|---|
| OpenAI Responses | `POST /v1/responses` | Codex (`stream:true` mandatory — aborts without SSE `response.completed`) |
| Anthropic Messages | `POST /v1/messages` | Claude Code (`ANTHROPIC_BASE_URL`, no `/v1` suffix) |
| OpenAI Chat | `POST /v1/chat/completions` | Cursorkit bridge, opencode, generic |
| Generic ACP | JSON-RPC stdio | ACP editors |

### OpenAPI service boundaries (each owned by one repo; all consumed by fusionkit)

| Service | Path / operationId | Owner |
|---|---|---|
| `HarnessExecutorService` | `POST /v1/harness/execute-coding-task` | handoffkit |
| `CursorHarnessService` | `POST /v1/cursor/normalize-run` | cursorkit |
| `MlxProviderService` | `GET /v1/mlx/model-endpoints/{id}` · `POST /v1/mlx/model-calls` | mlx-lm |
| `BenchmarkJoinService` | `POST /v1/benchmarks/join-execution` | fusionkit |

**Flow:** fusionkit defines the contract → handoffkit / cursorkit / mlx-lm each produce a slice of records at their boundary → fusionkit's fusion engine + `BenchmarkJoinService` consume them; handoffkit's Warrant plane wraps execution in signed contracts/receipts.

### FusionEngine internals (`fusionkit-core/fusion.py`)

`FusionEngine` = `HeuristicRouter` + `ChatTrajectoryProducer` + `JudgeSynthesizer`.

| Mode | Behavior |
|---|---|
| `single` | One call on `default_model`, no judge — a 1-element trajectory list |
| `self` | Same model sampled at multiple temperatures (self-consistency) |
| `panel` | One call per model across `panel_models`, then judge + synthesize |
| `router` | `HeuristicRouter` picks single/self/panel by keyword + length, then re-runs |

Panel fans out via `asyncio.gather` with per-attempt failure tolerance: a failed model becomes a `status=failed` trajectory; only **zero** survivors raises `PanelExhaustedError`.

**HeuristicRouter** (no model call — pure keywords + length):

| Decision | Trigger |
|---|---|
| hard → `panel` | architecture, benchmark, compare, research, verify (or >120 words) |
| medium → `self` | code, debug, math, plan, reason, review |
| else → `single` | short simple prompt |

**Judge → synthesizer loop:**
1. **Judge** — temperature-0 `analyze` → structured `FusionAnalysis` JSON (consensus, contradictions, unique_insights, coverage_gaps, likely_errors, recommended_final_structure). JSON-extraction fallback; sentinel on parse failure.
2. **Synthesizer** — one assistant turn grounded in candidate trajectories + judge JSON. Text fusion is terminal on turn 1 (zero tool rounds). Empty output falls back to best trajectory.
3. Result folds onto a consolidated trajectory's `synthesis` (`decision = select_trajectory` if the answer matched a candidate verbatim, else `synthesize`).

> Coupling smell: `FusionRunManager` (`run.py`) calls `engine._judge_synthesize` and `engine._generate_trajectories` — **private** API, not a public interface.

### Ensemble handoff (fusionkit ↔ handoffkit seam)

Pure stdin→stdout record bridge. FusionKit pipes a `benchmark-task-record.v1` on stdin; handoffkit runs governed harness candidates; stdout is a JSON envelope of records (benchmark-task → harness-run-request → harness-run-result → harness-candidate → judge-synthesis). Exit `0` even for `failed`/`skipped` records; nonzero only for CLI misuse. Rejects positional prompts — the task must come from stdin to preserve the exact hash.

---

## 3. Protocol

Contract layering: **JSON Schema** = persisted record + audit source of truth. **OpenAPI 3.1** = v1 HTTP/service source of truth. **Protobuf/Buf** = reserved future (not required for v1).

### Model Fusion Protocol — 16 record types (`schemaName` enum)

| Record | Meaning |
|---|---|
| `model_endpoint.v1` | Endpoint capability metadata (owner, provider, api_compatibility, capabilities) |
| `model-call-record.v1` | One model call: request_hash, side_effects, usage, response_hash |
| `fusion-run-request.v1` | Inbound fusion request (mode, messages, sampling) |
| `fusion-record.v1` | Top-level run: mode single/self/panel/router, trajectory_ids, final_output |
| `trajectory.v1` | **THE canonical fusion unit** — one model's attempt; items in Responses shape |
| `judge-synthesis-record.v1` | Folded into `trajectory.synthesis` (decision: synthesize/select/repair/failed) |
| `harness-run-request.v1` | Coding task to a harness (harness_kind, base_git_sha, prompt_hash) |
| `harness-run-result.v1` | Harness output: candidate_ids, capabilities |
| `harness-candidate-record.v1` | One worktree candidate (branch_name, worktree_path, score) |
| `cursor-run-request.v1` | Cursor adapter input |
| `cursor-run-result.v1` | Cursor output: raw_hash + redacted_hash, mapped_harness_result_id |
| `benchmark-task-record.v1` | Benchmark task definition (stdin to ensemble handoff) |
| `artifact-ref.v1` | Content-addressed artifact reference |
| `tool-call-plan.v1` | Planned tool calls at a pause point |
| `tool-execution-record.v1` | Executed tool result |
| `ensemble-receipt.v1` | **Minimal demo stub** — receipt hardening deferred to later tickets |

**`contractMetadata` envelope** (required on every non-common record): `schema`, `schema_version` (const `v1`), `schema_bundle_hash` (`sha256:<64hex>`), `producer`, `producer_version`, `producer_git_sha` (40-hex), `created_at` (RFC 3339). Pattern types: `hash` = `^sha256:[a-f0-9]{64}$`, `gitSha` = `^[a-f0-9]{40}$`.

### Warrant Protocol — 7 `warrant.*` types (`@fusionkit/protocol`)

| Record | Meaning |
|---|---|
| `warrant.contract.v1` | Signed run authorization (agent, task, policy, secrets, network, budget, disclosure) |
| `warrant.receipt.v1` | Signed record of what happened (eventsHead, workspaceOut, secretsReleased, modelsUsed) |
| `warrant.event.v1` | Hash-chained event; genesis `prev` = contractHash, `hash` = sha256{seq,ts,prev,event} |
| `warrant.manifest.v1` | Workspace capture manifest |
| `warrant.policy.v1` | Org policy snapshot (`policyHash` binds into the contract) |
| `warrant.checkpoint.v1` | Resumable state at a semantic boundary |
| `warrant.envelope.v1` | Portable continuation / handoff description |

**`RunEvent` union (the hash-chained log):** `run.created`, `run.claimed`, `workspace.materialized`, `policy.evaluated`, `consent.requested`, `consent.granted`, `secret.released`, `command.executed`, `file.changed`, `network.connected`, `model.called`, `boundary.crossed`, `artifact.created`, `checkpoint.created`, `run.completed`, `run.failed`, `run.cancelled`.

**Disclosure modes (bound to the contract):**

| Mode | Meaning |
|---|---|
| `none` | Nothing leaves the runner boundary but the receipt |
| `metadata-only` | Status, hashes, costs |
| `redacted` | Logs/diffs pass a redaction pipeline before crossing |
| `minimal-context` | Only declared artifact kinds cross |
| `full` | Everything crosses; recorded as such |

> Every actual crossing emits a `boundary.crossed` event regardless of mode, so the receipt proves the mode was honored.

### Schema-bundle-hash computation (canonical)

```python
# fusionkit/scripts/validate_contract_fixtures.py
payload = [{"path": p.name, "schema": load_json(p)}
           for p in sorted(schema_dir.glob("*.schema.json"))]
encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
hash = "sha256:" + hashlib.sha256(encoded).hexdigest()
# handoffkit has a byte-compatible TS twin: schemaBundleHash() in protocol/src/hash.ts
```

### The pins differ per consumer — by design (the integrity link)

| Repo | Protocol version | Schema bundle hash | State |
|---|---|---|---|
| fusionkit (origin) | 0.5.0 | `bb04c698…261867` | Up to date — defines the bundle |
| handoffkit | 0.5.0 (devDep) | `bb04c698…261867` | Up to date — same hash, guard-checked |
| cursorkit | 0.3.0 | `3e838859…ad87b8` | **TWO minors behind** |
| mlx-lm | lock (no semver) | `75792f89…bf35f3` | Trailing — only `model_endpoint` + `model-call` records |

A consumer only trusts records whose `schema_bundle_hash` equals the bundle it was built against — so the mismatch is **visible and safe**, but blocks unified-stack integration (~25%) until a coordinated release wave.

> Nuance: handoffkit's `model-fusion-bindings.json` `publishedProtocolMetadata.version` says `0.7.4` — that tracks handoffkit's **own** release, not the protocol pin (which is the `0.5.0` devDependency).

---

## 4. Trust & provenance

The Warrant receipt plane is cryptographically real. The model-fusion record plane and the observability spine are not. **Conflating them is the central trust trap.**

### Tier A — Warrant receipts: ed25519, sound (modulo key pinning)

- `verifyRunnerReceipt` / `verifyReceiptBundle` do real ed25519 checks, hash-chain verification, contract-hash binding, terminal-event matching, and cross-check `secretsReleased` against `secret.released` events.
- `contractHash` = sha256 over canonical JSON with signatures excluded. `ReceiptBundle` (`warrant.bundle.v1`) packs contract + receipt + events + public keys for fully offline verification.

**The gap (the code says so):** `verifyReceiptBundleUnchecked` "trusts nothing but the keys embedded in the bundle, which callers should pin or resolve from the org's published key manifest." A forged bundle signed with attacker-controlled keys verifies `ok:true` **unless the caller pins keys out-of-band**. And the shipped CLI exposes **no `verify` command**, so the only in-tree consumers are tests/examples.

### Tier B — Model-fusion records: provenance is decorative

```ts
// packages/ensemble/src/run.ts (and synthesis.ts, tool-executor.ts, model-gateway/provenance.ts)
const PRODUCER_GIT_SHA = "0".repeat(40);   // hardcoded zeros in every producer
const PRODUCER = "handoffkit-ensemble";
const PRODUCER_VERSION = "0.1.0";
```

Records are **unsigned, self-asserted strings**. The validator checks only format (`assertGitSha` accepts any 40-hex; `producer` just non-empty). There is no signature field on these records. So "provenance" tells you the producer's self-declared name and a placeholder SHA — it cannot prove who produced a record.

### Tier C — scope ingest endpoint has NO auth

```ts
// apps/scope/app/api/ingest/route.ts
export async function POST(request: Request) {
  for (const candidate of extractEvents(body)) {
    if (isFusionTraceEvent(candidate)) ingestEvent(candidate);  // structural guard only
  }
}
// No bearer token, no signature, no origin check.
// Anyone who can reach the collector injects arbitrary fusion-trace-event.v1; dashboard renders as truth.
```

> Trajectories are observational-only by design: `trajectory-capture` reconstructs from proxied wire traffic and carries raw observations, never a computed verdict. The optional `verification` block is whatever the harness self-reports.

### CRITICAL — shipped CLI ≠ documented CLI

README + `docs/cli.md` describe `warrant run`, `plane`, `runner`, `receipt`, `verify`, `bundle`, `continue`, `pull`. But `buildProgram()` only wires `ensemble`, `local`, `fusion`, `models`, `doctor`. `docs/cli.md:61` points at `packages/cli/src/commands/plane.ts` — **a file that does not exist**. The governance packages build and are unit-tested but are unreachable from the shipped CLI. The only `run` subcommand present is `ensemble run` (a local smoke).

### Trust remediation (ranked)

1. Wire real `producer_git_sha` (currently `0×40`) into all MF record producers.
2. Document that offline receipt verification **requires external key pinning**; ship a key manifest.
3. Authenticate scope ingest (bearer/signature) before any non-localhost deploy.
4. Reconcile `docs/cli.md` + README with the shipped CLI surface (remove or restore governance commands).
5. Harden `ensemble-receipt.v1` beyond the demo stub.
6. Decide whether MF records need signatures for any commercial provenance claim.

---

## 5. handoffkit

Flagship repo, two product identities (`warrant` plane + `fusionkit` gateway). 21 packages, ~50k TS LOC, 155 test files. v0.7.4 on npm (19 publishable). Maturity 7/10; Engineering 72%; Enterprise 38%.

**Package test coverage (top by LOC):**

| Package | LOC | Test files |
|---|---|---|
| cli | 11,861 | 34 |
| model-gateway | 6,345 | 20 |
| ensemble | 5,858 | 15 |
| adapter-ai-sdk | 4,777 | 16 |
| plane | 4,289 | 10 |
| protocol | 4,002 | 8 |
| handoff | 2,329 | 6 |
| runner | 1,264 | 2 |
| **sdk** | 238 | **0 — none** |
| **tools** | — | **0 — none** |

> `@fusionkit/sdk` (offline receipt verification client) and `@fusionkit/tools` (subprocess infra) have **no own tests**.

**CI gaps (`.github/workflows/ci.yml`):** `check` job runs `pnpm check` → build → OOTB CLI smoke → `pnpm test` → `pnpm demo all` → **`pnpm bench` (§8.4 budgets)** → `pnpm audit`. Plus `python` and `docker` jobs.
- **`apps/scope` tests never run in CI** — `pnpm test` globs `packages/*/dist/test`, `examples/*`, `test/*`; scope is an isolated workspace with its own lockfile, only **built** (in the release workflow), never `npm test`ed.
- **`microvm:bench` not gated** — manual, Vercel-credential-gated.

**Security:** Plane uses scrypt + AES-256-GCM at rest, RBAC principals, replay nonces, 50 rps rate limit. Docker default `WARRANT_MASTER_KEY=dev-master-key-change-me-in-production`. Docs bug: `self-hosting.mdx` says `FUSIONKIT_MASTER_KEY`; code uses `WARRANT_MASTER_KEY`. `SECURITY.md` claims design-stage / no releases — contradicts v0.7.4 on npm. Supply chain: 24 exact-pinned deps, `ignore-scripts`, 24h minimum-release-age.

**§8.4 performance budgets** (asserted by `pnpm bench`, corpus via `WARRANT_BENCH_FILES`):

| Budget | Ceiling | Notes |
|---|---|---|
| contract create p50 | 5,000 ms | CI: 2,000 files (spec target: 100k) |
| contract create p95 | 20,000 ms | |
| dryRun disclosure | 10,000 ms | In CI |
| claim-to-harness start (warm) | < 60 s | **NOT benchmarked** |
| offline verify | 1,000 ms | In CI |
| contract size | 10 MB | Excl. artifacts |

**§16.1 GTM validation gate:** interview 15–20 platform/security leads at 200–2,000-eng companies using ≥2 agent vendors. **Kill condition:** if security/budget pain is not a current budgeted problem with design-partner commitments within one quarter of outreach — stop. No evidence of completed interviews in repo.

**Plane architecture:** SQLite WAL (runs, events, receipts, blobs, runners, principals, enroll_tokens, claim_nonces). Postgres `PlaneStore` is interface-seam only (no adapter). Backup = `GET /v1/export` JSONL only. Metrics = flat counters at `/v1/metrics` (no Prometheus). Hourly retention sweeper + blob GC.

**Strengths:** 14 executable demos, offline-verifiable receipts, cross-repo release coordinator, Docker smoke in CI, perf bench in CI, 174+ manifest checks.

---

## 6. fusionkit

Local model fusion orchestrator. 5 Python packages, 232 tests, 80% coverage gate (~83% actual, enforced repo-wide via `coverage report` in CI). PyPI v0.7.1. Maturity 6.5/10.

**Packages:** `fusionkit-core` (config, clients, producers, judge/synth, router, contracts, run manager), `fusionkit-server` (FastAPI OpenAI-compatible gateway + single-model shim), `fusionkit-evals` (benchmark schemas, scorers, Pareto, fusion-bench, public-bench, tune-prompts), `fusionkit-mlx` (28-LOC `mlx_lm.server` launcher), `fusionkit-cli` (the published `fusionkit` dist).

**`fusionkit serve`** runs `create_app` (FastAPI) under uvicorn. Routes: `GET /health`, `GET /v1/models`, `POST /v1/fusion/runs` (+ `/{id}`, `/inspect`, `/events`, `/tool-results`), `POST /v1/chat/completions` (OpenAI-compatible), `POST /v1/fusion/trajectories:fuse`. `/v1/chat/completions` dispatches on the `model` field: if it names a configured endpoint → **passthrough** to that one model; reserved `fusionkit/{router,panel,single,self}` → fusion modes.

**Providers (7):** `openai`, `anthropic`, `google`, `openai-compatible`, `mlx-lm`, `custom`, `codex`. `build_client` maps `openai | openai-compatible | mlx-lm | custom → OpenAICompatibleClient` — so **mlx-lm is just an OpenAI-compatible client** pointed at a local `mlx_lm.server`.

**Broken `[mlx]` extra:** `pip install fusionkit[mlx]` warns "extra not provided" — the `mlx` extra lives on the `fusionkit-mlx` dist, not the `fusionkit` CLI dist. Working invocation: **`pip install fusionkit-mlx[mlx]`**.

**CI:** `ci.yml` (Ubuntu only) runs `uv lock --check`, ruff, pyright, pytest + coverage gate, build/`twine check`. **Missing: macOS runner (MLX paths never exercised), pip-audit / SCA, CodeQL, Dependabot, Docker sandbox e2e.** `pypi-release.yml` runs pytest **without** the coverage gate.

**Readiness by scenario:** local dev / MLX panel ~72%; HandoffKit gateway backend ~78%; PyPI install ~62%; internet-exposed server ~22%; public benchmark claims ~12%; scopekit observability ~38%.

---

## 7. cursorkit

Unofficial Cursor ConnectRPC research bridge. v0.1.4. 19.7k hand-written TS LOC, 161 tests, 50% coverage floors. Maturity 4/10.

> **Legal posture:** `DISCLAIMER.md` forbids hosted deployment. UNLICENSED. Cursor ToS risk for protocol reverse-engineering.

**What it does:** server-side interception of Cursor's backend protocol — keep Cursor's UX, route inference to a self-hosted OpenAI-compatible endpoint. Binds a local TLS bridge (`127.0.0.1:9443`). Everything is pass-through until a sanitized fixture proves a route's shape.

**Intercepted routes (13):** `AvailableModels`, `GetUsableModels`, `GetDefaultModelForCli`, `GetDefaultModel`, `NameAgent`, `GetServerConfig`, `/auth/full_stripe_profile`, `/auth/stripe_profile`, `AgentService/Run`, `AgentService/RunSSE`, `BidiService/BidiAppend`, `ChatService/StreamUnifiedChatWithTools`, `AnalyticsService/UploadIssueTrace`.

**Agent tools:** 31 surface entries; **9 actually wired** (`read_file`, `list_dir`, `grep`, `run_shell`, `write_file`, `apply_patch`, `delete_path`, `fetch_url`, `mcp_tool`). `BRIDGE_AGENT_TOOL_POLICY=safe` exposes 4; `all` exposes 9. `apply_patch` is synthesized from a read+write round trip (no native Cursor Exec tool). Full tool-execution loop (OpenAI `tool_calls` → Cursor `AgentServerMessage`) is acknowledged incomplete.

**Protocol pin:** 0.3.0, `sha256:3e838859…` (two minors behind origin).

**CI vs release gate gap:** PR CI runs codegen drift, `model-fusion:protocol:check`, `release:publish:check`, build, `test:coverage`, `format:check`, `pnpm audit`, pack, `--help`, `go test`. **Missing from PR CI** (only in documented manual gate): `pnpm release:check`, `pnpm baseline:check` (route/config/docs drift), `pnpm examples:check`.

---

## 8. mlx-lm

Velum fork of Apple `mlx-lm`. v0.31.3+structured.3. ~50k LOC, 298 tests. MIT (upstream). Private PyPI **unpublished**. Maturity 7/10.

> **SERVER.md:** "The MLX LM server is not recommended for production — basic security checks only." Default CORS `allowed-origins=*`. No HTTP auth.

**Positioning:** a provider/consumer of the model-fusion protocol, **not** its owner. Velum-added modules are all import-safe (no `mlx` import required): `model_fusion_protocol.py`, `model_fusion_contracts.py`, `openai_compat.py`, `server_metadata.py`, plus scripts and the lock.

**Protocol lock:** origin `velum-labs/handoffkit spec/model-fusion-contract`; hash `sha256:75792f89…`; records `model_endpoint.v1`, `model-call-record.v1` (provider-only — no FusionKit/HandoffKit imports). **No package semver pinned** — identified by bundle hash + OpenAPI 3.1 only.

**CI split:** `velum-protocol-validation` (Ubuntu, import-safe only, ~6 modules) is the real PR gate; `velum-private-release` (Ubuntu, build + validate + private PyPI or GH draft); upstream `pull_request` (self-hosted macOS, full MLX suite) is **guarded off** on the fork (`if: github.repository == 'ml-explore/mlx-lm'`). The fork's PR CI **never exercises real MLX inference**.

**Why unpublished:** `PRIVATE_PYPI_URL` secrets unset; the release workflow **explicitly refuses** public PyPI / GitHub Packages for Python; fallback is a draft GitHub Release with wheel artifacts. handoffkit's provisioner uses a git-SHA pin, not a registry wheel.

**Structured output:** `mlx-lm[structured]` extra for forced tool calls; without it `tool_calls` degraded, `structured_output` unsupported (36 tests in `test_structured.py`).

---

## 9. Benchmarks

| Surface | Readiness |
|---|---|
| Plane perf (§8.4) | ~85% (in CI, 2k-file corpus vs 100k spec target) |
| Public bench infrastructure | ~48–65% |
| Public headline claims | ~12% |

**fusionkit benchmark surface:** `fusion-bench` (Dirty Dozen, 12 tasks + handoff contract), `public-bench` (LiveCodeBench, Aider polyglot, SWE-bench Pro, Terminal-Bench), `public-bench-baselines`, `tune-prompts`, `pareto`, `eval`. Test coverage: `test_fusion_bench.py` (23), `test_public_bench.py` (23), `test_bench_reliability.py` (31) — ~105 bench tests total.

**Reliability features (LiveCodeBench):** sandboxed execution (`BENCH_SANDBOX` local/docker), error taxonomy (`scored` / `model_failed` / `infra_error` / `excluded` — only `scored` counts; transient failures retried before counting), per-problem checker fidelity, frozen `LCB_MANIFEST` pinning, pass@1 with Wilson 95% CI, per-run provenance (repo SHA, package versions, prompt-template hash, dataset revision), per-task cache + resume, `--ledger` drift tracking.

**Honest limitations:** cost scope is `solver_candidates_only` (judge + synthesizer token cost not surfaced); only `stdin` problems graded faithfully (special-judge / functional-call → `excluded`); baseline leaderboard numbers may use a different harness version.

**Outstanding for a defensible public number:** judge+synth cost capture; 100+ tasks × 3 seeds; CI subset gate; the spec's "claim-to-harness < 60s" is unbenchmarked.

> Note: `configs/benchmark-panel.example.yaml` is now a benchmark-only decorrelated peer panel (gpt-5.5 + claude-opus-4-8 + gemini-3-pro), separate from the product default. Earlier audit notes about a stray `gi#` typo and lopsided default-panel wording are stale.

---

## 10. Open-weight cloud benchmarking

**Key insight:** no MLX required. FusionKit's `provider: openai-compatible` lets you point a panel YAML at Together, Fireworks, DeepInfra, or self-hosted vLLM. The built-in `decorrelated-peers` panel uses **closed** models; for open-weight, check in a custom YAML with 3 decorrelated families. The LiveCodeBench adapter reads `FUSIONKIT_BENCH_CONFIG` — **not** the `--panel` flag (panel only affects baseline comparison).

**Two execution paths:**
- **Path A (fastest)** — in-process: `livecodebench_adapter.py` builds `FusionEngine` from YAML. No gateway, no HandoffKit.
- **Path B** — gateway: `fusionkit serve` + `public-bench --gateway-base-url` for SWE-bench Pro, Aider, Terminal-Bench (external official runners call `fusionkit/panel`).

**Hosting options:**

| Provider | Models | Base URL | API key env |
|---|---|---|---|
| Together AI | Qwen, Llama, DeepSeek, Mixtral | `https://api.together.xyz/v1` | `TOGETHER_API_KEY` |
| Fireworks AI | Llama, Qwen, DeepSeek | `https://api.fireworks.ai/inference/v1` | `FIREWORKS_API_KEY` |
| DeepInfra | Many HF models | `https://api.deepinfra.com/v1/openai` | `DEEPINFRA_API_KEY` |
| Self-hosted vLLM | Any HF model on GPU | `http://gpu-host:8000/v1` | `SERVE_API_KEY` |

**Recommended decorrelated open-weight panel** (comparable strength, different families — avoids lopsided oracle):

```yaml
endpoints:
  - id: qwen
    provider: openai-compatible
    model: Qwen/Qwen3-32B-Instruct
    base_url: https://api.together.xyz/v1
    api_key_env: TOGETHER_API_KEY
    timeout_s: 600
  - id: llama
    provider: openai-compatible
    model: meta-llama/Llama-3.3-70B-Instruct
    base_url: https://api.fireworks.ai/inference/v1
    api_key_env: FIREWORKS_API_KEY
    timeout_s: 600
  - id: deepseek
    provider: openai-compatible
    model: deepseek-ai/DeepSeek-V3
    base_url: https://api.deepinfra.com/v1/openai
    api_key_env: DEEPINFRA_API_KEY
    timeout_s: 600
default_model: qwen
judge_model: qwen
synthesizer_model: qwen
default_mode: panel
panel_models: [qwen, llama, deepseek]
sampling:
  temperature: 0.2
  max_tokens: 8192
```

**LiveCodeBench subset-first run:**

```bash
cd fusionkit
set -a && source .env && set +a
export FUSIONKIT_BENCH_CONFIG=configs/benchmark-panel-openweight.yaml
export LCB_MIN_DATE=2025-01-01
export BENCH_SANDBOX=docker
export LCB_CONCURRENCY=4

uv run --with 'datasets<4' fusionkit public-bench \
  --suite livecodebench \
  --subset 15 \
  --runner-command "python python/fusionkit-evals/adapters/livecodebench_adapter.py" \
  --output out/lcb-openweight.jsonl \
  --report out/lcb-openweight.md \
  --ledger out/lcb-ledger.jsonl
```

**Key LCB env vars:** `FUSIONKIT_BENCH_CONFIG` (panel YAML), `BENCH_SANDBOX` (`docker` for prod), `LCB_MANIFEST` (frozen question_ids), `LCB_CONCURRENCY` (lower on 429), `LCB_MAX_TESTS=0` (full official tests), `LCB_CHECKER` (exact/token/float/case_insensitive), `LCB_CACHE_DIR`, and the `datasets<4` pin.

**Cost (rough):** hard LCB task ~$0.07–0.13 (solver tokens only); 100 tasks × 3 seeds ≈ $40–120 API before judge. Self-hosting 2×A100 80GB (~$3–6/hr) breaks even around 30–60 GPU-hours for 70B-class.

**Repo gaps to add:** `configs/benchmark-panel-openweight.yaml`, an `openweight-peers` panel in `benchmark_panel.py` with baselines, a CI subset gate, pricing metadata on endpoints.

---

## 11. Ecosystem

- **Protocol rollout:** fusionkit + handoffkit on 0.5.0; cursorkit (0.3.0) and mlx-lm trailing → unified-stack integration blocked until a coordinated release wave.
- **Naming debt:** `WARRANT_MASTER_KEY` vs `FUSIONKIT_MASTER_KEY`, docker commands, `~/.warrant` vs `~/.fusionkit` paths, the dual brand.
- **License:** 42+ packages UNLICENSED — the single largest commercial blocker.
- **mlx fragmentation:** Velum fork unpublished; consumers use git-SHA pin; Apple Silicon only (cloud GPU must use vLLM/TGI).
- **Observability:** scope dashboard opt-in (`--observe`); no default structured logging on the fusionkit server; no mlx traces.
- **`FUSIONKIT_PYPI_VERSION = "0.7.0"`** in handoffkit `packages/cli/src/fusion/env.ts` lags the published 0.7.1.

---

## 12. Ranked blockers & remediation tiers

| # | Blocker | Detail | Category | Effort |
|---|---|---|---|---|
| 1 | No commercial license | 42+ UNLICENSED npm | Legal | 2–4 wk |
| 2 | GTM validation gate §16.1 | 15–20 interviews; kill condition | GTM | 4–12 wk |
| 3 | Shipped CLI ≠ docs | governance cmds unwired; `cli.md` cites missing `plane.ts` | Trust/Docs | 1–2 wk |
| 4 | Scope ingest unauthenticated | anyone reachable injects fusion-trace events | Security | 1 wk |
| 5 | Faked MF provenance | `producer_git_sha = 0×40`; records unsigned | Trust | 1–2 wk |
| 6 | mlx-lm unpublished | private PyPI unset; git pin only | Release | 2–3 wk |
| 7 | Docker ≠ fusion stack | Warrant plane only; no gateway | Deploy | 3–5 wk |
| 8 | cursorkit protocol lag | 0.3.0 vs 0.5.0 — different bundle hash | Contract | 1 wk |
| 9 | Receipt verify needs key pinning | offline `ok:true` trusts in-bundle keys | Trust | 1–2 wk |
| 10 | Warrant/FusionKit naming | `WARRANT_MASTER_KEY`, docker cmds | Ops | 2–4 wk |
| 11 | SECURITY.md stale/missing | claims no releases at v0.7.4 | Trust | 1 wk |
| 12 | Broken `fusionkit[mlx]` extra | extra on `fusionkit-mlx` dist, not CLI | Bug | <1 day |
| 13 | `FUSIONKIT_PYPI_VERSION` 0.7.0 | CLI pulls stale synthesizer | Bug | <1 day |
| 14 | Cursor tunnel limits | research bridge; plan-only | Product | ongoing |
| 15 | Observability not default | scope opt-in; no mlx traces | Ops | 3–6 wk |

### Tier 1 — Design partners (2–4 weeks)
Ship-safe for 3–5 technical design partners on self-hosted single-node.
- [ ] Choose license (BSL/commercial/dual) + apply to 42 manifests
- [ ] Rewrite `SECURITY.md` in all repos; fix handoffkit support table
- [ ] Publish mlx-lm to private PyPI OR document git-install as official
- [ ] Bump `FUSIONKIT_PYPI_VERSION` 0.7.0 → 0.7.1
- [ ] Reconcile shipped CLI vs docs (remove or restore governance commands)
- [ ] Authenticate scope ingest before any non-localhost deploy
- [ ] Release cursorkit with protocol 0.5.0 pin (coordinated apply)
- [ ] Operator runbook: install, master key, backup/restore, upgrade
- [ ] GTM interviews per §16.1 or scope to technical preview
- [ ] Remove `UV_FIND_LINKS` hack from fusionkit-sandbox

### Tier 2 — Partner bundle (4–8 weeks)
- [ ] Docker compose v2: plane + gateway + `fusionkit serve`
- [ ] Push image to registry
- [ ] `FUSIONKIT_MASTER_KEY` alias; docker commands; `~/.fusionkit` paths
- [ ] Verify scope bundle in every `@fusionkit/cli` release
- [ ] Prometheus exporter or documented metrics wrapper
- [ ] macOS CI for MLX-critical paths (fusionkit + handoffkit)
- [ ] Add `release:check` + `baseline:check` to cursorkit PR CI
- [ ] fusionkit: LICENSE, `[mlx]` extra fix, pip-audit in CI
- [ ] Wire real `producer_git_sha`; add `apps/scope` tests + `microvm:bench` to CI

---

## 13. Operator journey

Gap analysis for someone trying to self-host the full fusion stack today:

1. **Install** — `pip install fusionkit[mlx]` silently installs no MLX (use `fusionkit-mlx[mlx]`). npm CLI installs fine.
2. **Run governance** — README commands (`warrant run/plane/verify`) don't exist in the shipped binary; only the fusion gateway is reachable.
3. **Deploy** — Docker compose covers the Warrant plane only, not the gateway + `fusionkit serve` fusion stack.
4. **Secrets** — env var name mismatch between docs (`FUSIONKIT_MASTER_KEY`) and code (`WARRANT_MASTER_KEY`); default dev key ships.
5. **Observe** — scope dashboard is opt-in and its ingest is unauthenticated.
6. **Trust** — receipts verify offline only if you pin keys out-of-band; model-fusion records carry placeholder provenance.
7. **MLX** — the Velum fork is unpublished; you self-resolve via git pin; Apple Silicon only.

---

*Generated from a 4-agent deep audit. Agent IDs: protocol `652d4504`, handoffkit arch `4e0f3330`, fusionkit engine `6cda42d0`, cursorkit+mlx-lm `6452a6d0`.*
