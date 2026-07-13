# OSS Release Audit — Consolidated Findings

Date: 2026-07-05. Scope: entire repository at commit `dc2c8e4` on `main`.
Method: six parallel deep audits (repo hygiene, TypeScript workspace, Python
workspace, CLI UX/DX, documentation, public surface/security) plus git-history
forensics. Severity scale: **P0** = blocks flipping the repo public, **P1** =
blocks calling it "released", **P2** = polish.

Sections:

1. [Identity & branding](#1-identity--branding)
2. [Legacy governance stack entanglement](#2-legacy-governance-stack-entanglement)
3. [Repo hygiene & leftover artifacts](#3-repo-hygiene--leftover-artifacts)
4. [Security, privacy & licensing](#4-security-privacy--licensing)
5. [Git history & branch forensics](#5-git-history--branch-forensics)
6. [TypeScript code quality](#6-typescript-code-quality)
7. [Python code quality & packaging](#7-python-code-quality--packaging)
8. [CLI UX/DX](#8-cli-uxdx)
9. [Documentation](#9-documentation)
10. [CI/CD & release engineering](#10-cicd--release-engineering)
11. [Positioning & proof](#11-positioning--proof)

---

## 1. Identity & branding

The repo carries **three product identities** simultaneously: Warrant (legacy
governance), handoffkit (the private repo name), and FusionKit (the actual
product). A public visitor encounters all three in the first minute.

| ID | Finding | Evidence | Sev |
| --- | --- | --- | --- |
| 1.1 | Root workspace is named `warrant` with description "governed execution and provenance plane" | `package.json` line 2 | P0 |
| 1.2 | Every published npm package's `repository.url` points to `git+https://github.com/velum-labs/handoffkit.git`; `release/npm-packages.json` sets `canonicalRepository: velum-labs/handoffkit` | all `packages/*/package.json` | P0 |
| 1.3 | JSON Schema `$id`s use `https://schemas.velum.ai/fusionkit/...` (16 files) | `spec/model-fusion-contract/schema/*.schema.json` | P1 |
| 1.4 | OpenRouter attribution header hardcodes `HTTP-Referer: https://github.com/velum-labs/handoffkit` in generated registry data (both TS and Python) | `spec/registry/providers.json`, `packages/registry/src/generated/data.ts`, `python/fusionkit-core/src/fusionkit_core/_generated/registry_data.py` | P1 |
| 1.5 | `CHANGELOG.md` footer says releases are for "the handoffkit release units"; every entry is boilerplate ("Release cut via cross-repo coordinator") with no user-facing notes | `CHANGELOG.md` | P1 |
| 1.6 | Stale `warrant` naming in code/docs: `scripts/demo.mjs` banner ("warrant examples"), `packages/cli/src/commands/ensemble.ts:98` default output dir `.warrant/ensemble-cli`, `packages/cli/src/commands/local.ts` header comment, `WARRANT_*` env aliases in `packages/tools/src/env-compat.ts`, Docker "Warrant — Control Panel", docs using `warrant plane start` / `warrant ensemble handoff` | multiple | P1 |
| 1.7 | Docs domain `fusionkit.velum-labs.com` hardcoded in README and `apps/docs/app/layout.tsx` `metadataBase`; site GitHub link → `velum-labs/handoffkit` | `apps/docs/app/layout.config.tsx` | P1 |
| 1.8 | Protocol package published as `@velum-labs/model-fusion-protocol` / Python `velum-model-fusion-protocol`, a second scope alongside `@fusionkit/*` | `spec/model-fusion-contract/package.json`, scripts | P1 |
| 1.9 | Terminology drift: "ensemble" (README title) vs "fusion" (CLI) vs "panel" (internals); "handoff" means both rate-limit failover (product) and the governance continuation SDK (legacy) | README, `docs/quickstart-handoff.md` vs `docs/handoff-sdk.md` | P2 |

## 2. Legacy governance stack entanglement

`docs/scope.md` honestly declares the split, but the tree does not implement it —
and in one place scope.md is factually wrong.

| ID | Finding | Evidence | Sev |
| --- | --- | --- | --- |
| 2.1 | **`docs/scope.md` claims governance commands "are not registered any more" — false.** `registerDeployment(program)` in `packages/cli/src/cli.ts:53` still wires `ui`, `runs`, `plane start`, `runner start` into the shipped CLI | `packages/cli/src/commands/deployment.ts:23-106`, `docs/scope.md:23-26` | P0 |
| 2.2 | 8 legacy packages (`plane`, `runner`, `sdk`, `handoff`, `adapter-compute`, `session-hermetic`, `session-vercel-sandbox`, `session-harness`) are in the **published npm set** (24 published packages; product core is ~16) | `release/npm-packages.json` | P0 |
| 2.3 | Product packages import legacy ones: `tool-claude/src/harness.ts` → `@fusionkit/runner` + `@fusionkit/session-harness`; `adapter-ai-sdk` exports governance surfaces (`swarmTools`, `remoteTools`, `handoffModel`, `routedModel`) alongside product `mlxServer`; `cli/src/config.ts` → `@fusionkit/plane`; `cli/src/render.ts` exports a legacy renderer used only by governance examples | package sources | P0 |
| 2.4 | `packages/ensemble/package.json` declares deps on `runner` and `session-harness` with **zero source imports** — dead dependency edges that keep legacy packages in the install closure | `packages/ensemble/package.json` | P1 |
| 2.5 | **14 of 15 example demos are governance demos** (`governed-run`, `consent-secrets`, `egress-policy`, `hermetic-session`, `swarm`, …); only `runtime-kernel` is a product demo, and it is *not* in the acceptance suite (`test/demos.test.js` covers demos 01–14) | `examples/manifest.json`, `test/demos.test.js` | P0 |
| 2.6 | Root `Dockerfile` + `docker-compose.yml` build the legacy Warrant stack (installs a `warrant` binary, control panel on :7172) and CI runs a Docker warrant smoke as a release gate | `Dockerfile`, `docker-compose.yml`, `.github/workflows/ci.yml` | P1 |
| 2.7 | 4 of 5 dated `spec/*.md` documents are governance specs (governed-agent-execution-plane, local-first-handoff, ENG-596 microVM spike, ENG-597 secret receipts); `scripts/check-repo.mjs` lines 19–22 *require* them to exist, so archiving needs a check update. The 5th (`local-model-harness-bridge`) is product-relevant but written against the `warrant local` CLI | `spec/`, `scripts/check-repo.mjs` | P1 |
| 2.8 | Internal ticket IDs (`ENG-596`, `ENG-597`, `MF-60..62`, `ENG-594`) leak in specs, docs, and the examples manifest | `docs/public-benchmark-smoke.md`, `docs/model-fusion-learnings.md`, `docs/fusion/incomplete-work-inventory.md` | P2 |
| 2.9 | Dead exports kept for legacy: `clientFor`, `waitForTerminal` in `packages/cli/src/shared/plane.ts` are never imported | grep across packages | P2 |

## 3. Repo hygiene & leftover artifacts

| ID | Finding | Evidence | Sev |
| --- | --- | --- | --- |
| 3.1 | `PRODUCTION_READINESS_AUDIT.md` (35 KB) at root: internal Velum Labs GTM/readiness audit across five private repos, with readiness percentages, commercial layers, "design partner ~75%" | root | P0 |
| 3.2 | `release/state.json` committed with a developer's machine path (`/Users/alen/Documents/Development/handoffkit/...`) and CI run state; docs call it a `.tfstate`-like cache; not gitignored (only `release/.plans/` is) | `release/state.json:5` | P0 |
| 3.3 | `references/` — 284 vendored files from `sst/opencode` and `pingdotgg/t3code` with **no upstream LICENSE files copied**, tracked by root-level `trackcn.json` (38 KB); contains a real-looking personal email (`jmarminge@gmail.com` in `references/t3code/provider/Layers/CursorProvider.test.ts:524,533`) and other users' home paths | `references/`, `trackcn.json` | P0 |
| 3.4 | Root `fusionkit.json` is a *legacy v1* config the CLI auto-migrates away from; duplicates/conflicts with the canonical `.fusionkit/fusion.json` (v3) | `packages/cli/src/fusion-config.ts` | P1 |
| 3.5 | `ENSEMBLE_PRODUCT_PLAN.md` (18 KB) and `HARNESS_PROMPT_PASSTHROUGH_SPEC.md` (18 KB) at root: internal planning artifacts, partially stale, the latter with a handoffkit header | root | P1 |
| 3.6 | `.cursor/skills/` + `.cursor/plans/` committed: internal agent automation exposing spend caps ($100 hill-climb / $500 production audit), velum multi-repo release ops, and a 744-line internal provider research spec. No API keys found | `.cursor/` | P1 |
| 3.7 | `test/` (Node demo tests) vs `tests/` (32 root-level *Python* test files that belong to `python/fusionkit-*` packages) — confusing dual layout; root pytest `testpaths = ["tests", "python"]` | root, `pyproject.toml` | P1 |
| 3.8 | `portless.json` at root is dev-only routing config; better placed under `apps/` or documented | root | P2 |
| 3.9 | Internal artifact paths in docs: `/Users/alen/.openclaw/workspace/artifacts/` on host `velum-mini` in three docs; `cd /Users/alen/Documents/Development/handoffkit` in another | `docs/local-mlx-panel-demo.md:70`, `docs/handoffkit-fusion-bench.md:51`, `docs/fusionkit-handoff-executor.md:54`, `docs/fusion-judge-trajectory.md:92` | P1 |
| 3.10 | `docs/generated/code-api.md` (1,093 lines) is committed generated output — acceptable pattern (CI-checked), but must be documented in CONTRIBUTING | `docs/generated/` | P2 |
| 3.11 | Stale one-off scripts: `scripts/migrate_runs_to_trajectory.py` (one-shot migration), `simple_openai_server.py` / `simple_mlx_openai_server.py` (superseded demo servers, still doc-referenced) | `scripts/` | P2 |

## 4. Security, privacy & licensing

**No live secrets found in the tree** (all `sk-…` matches are synthetic test
fixtures; no `.env` files; no `ghp_`/`AKIA`/private-key matches). Remaining issues:

| ID | Finding | Evidence | Sev |
| --- | --- | --- | --- |
| 4.1 | **`SECURITY.md` states the repo is "design-stage and private… no released versions"** — false (npm/PyPI 0.8.0 shipped) and dangerous as public policy | `SECURITY.md:5-24` | P0 |
| 4.2 | Two *published* packages lack a shipped LICENSE file: `@fusionkit/harness-core`, `@fusionkit/runtime-utils` (`files: ["dist", "LICENSE"]` but no LICENSE present) | `packages/harness-core/`, `packages/runtime-utils/` | P0 |
| 4.3 | No root `NOTICE`; `spec/model-fusion-contract/package.json` missing a `license` field; `python/uniroute*` are `UNLICENSED` inside an Apache-2.0 repo | multiple | P1 |
| 4.4 | **Committed `.fusionkit/fusion.json` routes this repo's default panel through OpenRouter** (third-party aggregator) — anyone cloning and running `fusionkit codex` in-repo sends code to OpenRouter, undisclosed; also diverges from the documented default frontier trio | `.fusionkit/fusion.json` | P0 |
| 4.5 | Sessions persist **full prompt/message arrays** (user code included) to `~/.fusionkit/sessions/<id>/turns.jsonl` — mentioned in passing, no privacy/data-handling doc | `packages/model-gateway/src/session-store.ts:12-18` | P1 |
| 4.6 | Rate-limit failover (`onRateLimit: fusion`, the default) re-sends the current turn to *additional* providers beyond the one the user selected — privacy implication undocumented | `packages/model-gateway/src/fusion-backend.ts:966-975`, `packages/cli/src/fusion/effective-config.ts:38` | P1 |
| 4.7 | No product telemetry / phone-home (verified) — a strength; should be stated affirmatively in the privacy doc. `HF_HUB_DISABLE_TELEMETRY` is set for MLX downloads | `packages/adapter-ai-sdk/src/mlx-env.ts` | P2 |
| 4.8 | `.github/CODEOWNERS` is an unfilled placeholder referencing `@velum-labs/<team>` | `.github/CODEOWNERS` | P1 |
| 4.9 | Supply chain posture is strong (exact-pin allowlist in `check-repo.mjs`, `.npmrc` with `ignore-scripts`/`minimum-release-age`/provenance publishing, committed lockfiles) — keep; document in CONTRIBUTING | `.npmrc`, `scripts/check-repo.mjs:326-427` | — |
| 4.10 | Stale claim that CI needs `PACKAGES_READ_TOKEN` for GitHub Packages (protocol is on public npm now); Dockerfile/compose still reference it | `packages/protocol/docs/model-fusion-consumption.md:85-87`, `Dockerfile` | P2 |

## 5. Git history & branch forensics

Verified directly (not by subagent):

| ID | Finding | Evidence | Sev |
| --- | --- | --- | --- |
| 5.1 | Main history is small (pack ≈ 7.9 MiB) and contains **no deleted secret files** (the only deleted "secret"-named paths are demo source files) | `git log --all --diff-filter=D`, `git count-objects -vH` | — |
| 5.2 | **Remote side branches contain internal billed-benchmark artifacts**: `audit/20260701-2027/phase3/bank-slim.json` (522 KB), `analysis/phase0/c3_spend_ledger.jsonl` (345 KB spend ledger), 4.7 MB `python/model-area-index/snapshots/*` blobs — e.g. on `origin/cursor/fusion-production-audit-c70f`. If the repo is flipped public with all branches, these ship | `git rev-list --objects --all`, `git branch -r --contains` | P0 |
| 5.3 | 43 remote branches (cursor/* work branches, dependabot, clawdius/*) and 25 `handoffkit-v*` tags would all become public | `git branch -r`, `git tag -l` | P1 |
| 5.4 | Committer identities include personal emails and an internal Tailscale hostname (`benjamin@velum-mini.tail0c34cf.ts.net`) — normal for git but worth a conscious decision (D3) | `git log --format='%ae'` | P2 |

## 6. TypeScript code quality

Strengths first: `strict` + `noUncheckedIndexedAccess` on; **zero** `@ts-ignore` /
`as any` across `packages/`; typed error taxonomy (`HarnessError`,
`PolicyDeniedError` → exit 2); a real shared driver contract in `harness-core`;
no empty catch blocks; presenter-based CLI output with a `console.*` ban enforced
by `check-repo.mjs` in `cli`/`cli-ui`.

| ID | Finding | Evidence | Sev |
| --- | --- | --- | --- |
| 6.1 | **God file:** `packages/model-gateway/src/fusion-backend.ts` — 2,041 lines mixing public types, session state, vendor proxy/failover, SSE assembly, cost metering, trace emission, and the `FusionBackend` class. Partially superseded by `frontdoor/`; also contains 11 raw `console.*` calls (gateway is outside the lint ban) | file | P1 |
| 6.2 | **God file:** `packages/kernel/src/runtime.ts` — 1,421 lines (type system + graph engine + scheduling + streaming) and **zero tests** for the whole `kernel` package | file | P1 |
| 6.3 | **God file:** `packages/ensemble/src/unified.ts` — 949 lines (harness kind registry + panel orchestration + factories + judge hooks) | file | P1 |
| 6.4 | **Dual harness implementations:** legacy `harness.ts` vs new `driver.ts` coexist in tool-codex (932 vs 445 lines), tool-claude, tool-cursor, gated by `FUSIONKIT_HARNESS_DRIVERS` env flag — two code paths to maintain and test | `packages/tool-*/src/` | P1 |
| 6.5 | DRY: near-identical stream-json trajectory parsers in `tool-claude/src/stream-trajectory.ts` (222 ln) and `tool-cursor/src/stream-trajectory.ts` (184 ln) — same helpers (`truncate`, `asObject`, `asArray`, …) | files | P1 |
| 6.6 | DRY: OpenAI chat wire types (`OpenAiToolCall`, `OpenAiDelta`, `OpenAiChoice`) duplicated in `model-gateway/src/adapters/responses.ts:61-80` and `adapters/anthropic.ts:67-80`; SSE chunk builders duplicated between `frontdoor/sse.ts` and inline in `fusion-backend.ts` (~638–662) | files | P2 |
| 6.7 | DRY: fused sub-agent provisioning implemented 3× (`tool-codex/src/launch.ts` TOML, `tool-claude/src/launch.ts` JSON, `tool-cursor/src/subagents.ts` markdown) with no shared builder | files | P2 |
| 6.8 | Missing tests: `kernel` (0), `sdk` (0), `tools` (0); the product demo `runtime-kernel` is excluded from the demo acceptance suite | `packages/*/src/test/` | P1 |
| 6.9 | Publishing metadata: only 2 of 24 published packages have READMEs (`cli`, `ensemble`); **zero** packages have `keywords`; several descriptions still say "Warrant" | `packages/*/package.json` | P1 |
| 6.10 | TODO inventory is small and honest (9 TODOs, no FIXME/HACK) — notable: `cli/src/render.ts` (legacy renderer keep-or-remove), `fusion/stack.ts` (brittle provider error classification), `tool-codex/src/launch.ts` (hardcoded cache paths) | grep | P2 |

## 7. Python code quality & packaging

Strengths: clean TODO/FIXME slate; consistent `# noqa: BLE001` on all 13 broad
exception handlers with narrow intent; single-source registry generated from
`spec/registry/*.json` into both languages; prompts have one canonical source
(`fusionkit_core/prompts.py`) with Node fetching via `fusionkit prompts dump`.

| ID | Finding | Evidence | Sev |
| --- | --- | --- | --- |
| 7.1 | **`uniroute` / `uniroute-mlx` are unrelated research code** (arXiv 2502.08773 cost-quality routing) — zero imports shared with fusionkit, UNLICENSED, excluded from pyright. Not a rename/duplicate; a cohabiting research project | `python/uniroute*/` | P1 |
| 7.2 | **Wheel data bug:** `fusionkit_evals` references `fixtures/tiny-phase1` and `benchmarks/dirty-dozen/` *outside* `src/`, and `uv_build` ships only `src/` — `pip install fusionkit && fusionkit tiny-bench` likely fails at runtime outside a repo checkout. `adapters/*.py` also live outside `src/` and aren't importable when installed | `python/fusionkit-evals/src/fusionkit_evals/tiny.py`, `dirty_dozen.py` | P0 |
| 7.3 | **Default install pulls the whole benchmark stack:** PyPI `fusionkit` hard-depends on `fusionkit-evals` (hillclimb, public-bench, prompt-tuning, ~380-line re-export `__init__`) — end users wanting `serve` get maintainer tooling and its dep closure | `python/fusionkit-cli/pyproject.toml` | P1 |
| 7.4 | PyPI metadata gaps on all five published packages: no `readme`, no `classifiers`, no `project.urls`, no `authors`, no keywords — bare PyPI pages | `python/fusionkit-*/pyproject.toml` | P0 |
| 7.5 | God modules: `fusionkit_core/clients.py` (1,649 ln — error taxonomy + retries + 4 provider clients + SSE parsing + tool-call reassembly + fakes), `fusionkit_cli/main.py` (1,474 ln — every command in one Typer file), `fusionkit_evals/fusion_bench.py` (1,280 ln) | files | P1 |
| 7.6 | 32 FusionKit test files at repo root `tests/` instead of per-package `python/*/tests/`; `python/fusionkit-cli/tests/` has only a version smoke test | `tests/`, `pyproject.toml` | P1 |
| 7.7 | Version drift: FastAPI app metadata hardcodes `version="0.2.0"` while packages are 0.8.0; five pyprojects pin `==0.8.0` on each other requiring lockstep bumps (works, but document it) | `python/fusionkit-server/src/fusionkit_server/app.py:146` | P2 |
| 7.8 | Pyright is standard mode (not strict) and excludes uniroute entirely; ~50 `type: ignore` concentrated at MLX/generated-registry edges — acceptable, document the policy | root `pyproject.toml:45-58` | P2 |
| 7.9 | Python users of `fusionkit serve -c config.yaml` don't get `.fusionkit/prompts/*.md` auto-loading (Node-only concern today) — parity gap | `fusionkit_core/config.py` | P2 |
| 7.10 | Internal references: `HandoffKitExecutor*` naming in `fusion_bench.py`, `/opt/velum/repos/handoffkit/...` and `fusionkit@velum.local` in tests, hardcoded external baseline scores for `gpt-5.5`/`gpt-5.3-codex` in `public_bench.py` (fine if labeled) | files | P2 |

## 8. CLI UX/DX

The product spine (`fusionkit codex` cold start → preflight with copy-paste
install hints → adaptive key skipping → cost consent → boot checklist → session
receipt with resume hint) is genuinely good. What breaks the magic:

| ID | Finding | Evidence | Sev |
| --- | --- | --- | --- |
| 8.1 | `fusionkit --help` shows legacy governance commands (`ui`, `runs`, `plane start`, `runner start`) and leads with `ensemble` (registration order), not the product spine — a newcomer can't tell which 3 commands matter | `packages/cli/src/cli.ts:29-55` | P0 |
| 8.2 | **Binary name collision:** npm `@fusionkit/cli` and PyPI `fusionkit` both install a `fusionkit` binary; whichever is later on PATH silently wins. Version flags differ (`-v` Node vs `-V` Python) | `packages/cli/package.json:13-15`, `python/fusionkit-cli/pyproject.toml:16-17` | P0 |
| 8.3 | **Dual `init`, dual config:** Node `init` scaffolds `.fusionkit/fusion.json` (v3); Python `init` writes `fusionkit.yaml` — team config drift if a teammate pip-installs. Node `init` also has a legacy trap: passing `--dir`/`--host`/`--plane-url` triggers *governance plane home init* instead | `packages/cli/src/commands/fusion.ts:262-268`, `python/fusionkit-cli/src/fusionkit_cli/onboarding.py:35-36` | P1 |
| 8.4 | **Same command, different products:** Node `fusionkit serve` (full stack orchestration) vs Python `fusionkit serve` (raw uvicorn router) share a name | `fusion-quickstart.ts:689-697` vs `main.py:150-169` | P1 |
| 8.5 | Python `--help` lists 10 maintainer/benchmark commands (`fusion-hillclimb`, `tune-prompts`, `public-bench`, …) as top-level peers of `serve`/`init`; root help string is "Local model fusion toolkit." (undersells) | `python/fusionkit-cli/src/fusionkit_cli/main.py:63,447-1168` | P1 |
| 8.6 | `doctor` prints "ready. Try: fusionkit codex" (exit 0) even when all provider keys are missing — only uv absence is a hard fail | `packages/cli/src/commands/doctor.ts:272-283` | P1 |
| 8.7 | Resolved: the single-model path is now `fusionkit <tool> --direct`; `--local` remains the fused MLX panel flag. | `docs/cli.md` | — |
| 8.8 | No shell completions; no update notifications; flag-order rule ("fusionkit flags before tool name") is a recurring paper cut; several env vars (`FUSIONKIT_NO_TUI`, `FUSIONKIT_SKIP_KEY_VALIDATION`, `FUSIONKIT_CONFIG`) undocumented in help | CLI sources | P2 |
| 8.9 | Good bones worth keeping/extending: stderr/stdout contract (human UI vs machine payloads), `--json` on most inspection commands, Ink TTY / plain non-TTY split, exit codes 0/1/2/130 | `packages/cli-ui/` | — |

## 9. Documentation

| ID | Finding | Evidence | Sev |
| --- | --- | --- | --- |
| 9.1 | **Two doc layers with contested canonicality:** README's quickstart links to `docs/*.md` while `docs/README.md` declares the Fumadocs site (`apps/docs`) canonical for users — guaranteed drift (already present: Fumadocs config examples use schema v2, current is v3) | `docs/README.md`, `apps/docs/content/docs/getting-started/configuration.mdx` | P0 |
| 9.2 | **Public site presents the legacy product as a peer:** home-page feature card "Governed execution", Concepts/Architecture/Self-Hosting pages describe the Warrant plane; `docs/concepts.md` opens with "Warrant is built around…" | `apps/docs/app/(home)/page.tsx`, `docs/architecture.md`, `docs/concepts.md`, `docs/operations.md` | P0 |
| 9.3 | Missing OSS baseline docs: no `CONTRIBUTING.md`, no `CODE_OF_CONDUCT.md`, no issue templates, no PR template, no FAQ, no roadmap link, no privacy doc | `.github/` | P0 |
| 9.4 | The headline claim (open-weight fusion ≥ frontier at lower cost) is **absent from the README** — no benchmark table, no methodology link, no comparison to alternatives (LiteLLM, OpenRouter, MoA); "open-weight" appears once. Internal evidence exists (`benchmarking-runbook.md`, `public-benchmark-comparison.md`, `docs/fusion/FUSION_VALUE_RUBRIC.md`) but is unpublished | `README.md` | P1 |
| 9.5 | Accuracy bugs found by spot-check: `scope.md` governance-commands claim (see 2.1); `fusionkit-handoff-executor.md` uses `warrant ensemble handoff`; `prompts dump --output` documented but flag is `--dir`; Fumadocs schema v2 examples; `operations.md` uses `warrant plane start` | multiple | P1 |
| 9.6 | `docs/fusion/` mixes contributor docs with internal artifacts that must not ship unlabeled: `MOA_IMPLEMENTATION_PROMPT.md` (a literal agent prompt), `incomplete-work-inventory.md`, `STABILIZATION.md`, `FUSION_VALUE_RUBRIC.md`, `coding-capability-index-report.md`; `documentation-taxonomy.md`'s own inventory omits 5 of them | `docs/fusion/` | P1 |
| 9.7 | Confusing pairs: `operations.md` (governance plane ops) vs `operations-and-scripts.md` (repo scripts); `getting-started.md` (contributor setup) vs `quickstart-*.md` (user quickstarts); three "handoff" docs where only one is product | `docs/` | P2 |
| 9.8 | Fumadocs CLI reference is a subset — missing `config get/set/unset/edit`, `prompts`, `ensemble` CRUD, `runtime`, `version` | `apps/docs/content/docs/cli/commands.mdx` vs `docs/cli.md` | P2 |
| 9.9 | README polish gaps: no badges, no demo GIF/video, quickstart one-liner omits `fusionkit setup` and the git-repo prerequisite | `README.md` | P2 |

## 10. CI/CD & release engineering

Strengths: no `pull_request_target`; `contents: read` on CI; release workflows
org-gated (won't publish from forks); npm OIDC + provenance; PyPI trusted
publishing; strong `.npmrc`.

| ID | Finding | Evidence | Sev |
| --- | --- | --- | --- |
| 10.1 | CI's release gates include legacy surfaces: `pnpm demo all` runs the 14 governance demos; a Docker job builds and smoke-tests the Warrant stack. FusionKit-only CI doesn't exist | `.github/workflows/ci.yml` | P1 |
| 10.2 | All release workflows are guarded by `github.repository == 'velum-labs/handoffkit'` — a rename/transfer silently disables publishing until updated | `.github/workflows/*.yml` | P0 (with D1) |
| 10.3 | No CodeQL / security scanning workflow; dependabot covers npm/actions/docker but **not pip/uv** | `.github/dependabot.yml` | P1 |
| 10.4 | `scripts/check-repo.mjs` hardcodes ~200 required file paths including the legacy specs and root plan docs — every file move in this cleanup must update it (it is the de-facto manifest of the repo) | `scripts/check-repo.mjs` | P1 |
| 10.5 | No macOS CI runner — MLX (`--local`) paths never CI-tested; acceptable if documented | `.github/workflows/ci.yml` | P2 |

## 11. Positioning & proof

| ID | Finding | Evidence | Sev |
| --- | --- | --- | --- |
| 11.1 | The product story is "SOTA performance from open-weight models in your existing harness, cheaper than frontier" — but the built-in default panel is the **frontier trio** (gpt-5.5 / claude-sonnet-4-6 / gemini-2.5-pro) and the only open-weight default lives in this repo's committed OpenRouter config. The flagship configuration contradicts the pitch (D5) | `packages/registry/src/generated/data.ts:193-208` | P1 |
| 11.2 | No public, reproducible benchmark artifact backs the claim. The machinery exists (`fusion-bench`, `public-bench`, hillclimb, `FUSION_VALUE_RUBRIC.md`, baselines table in `public_bench.py`) but nothing is published or linked from the README | `docs/benchmarking-runbook.md` | P1 |
| 11.3 | The cost story (budgets, per-turn USD metering, receipts) is implemented and is a differentiator — under-marketed in README/docs | `packages/model-gateway` cost metering | P2 |
