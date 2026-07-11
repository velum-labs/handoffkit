# OSS Release Remediation Workstreams

Each workstream below is written as a self-contained brief for a dedicated agent.
Finding IDs (e.g. `2.1`) refer to [`audit-findings.md`](audit-findings.md).
Decision IDs (`D1`–`D7`) refer to the decisions table in [`README.md`](README.md).

Global rules for every workstream:

- Update `scripts/check-repo.mjs` for every file you add, move, or delete — it is
  the manifest of required files and will fail CI otherwise (finding 10.4).
- Gate: `pnpm check && pnpm build && pnpm test` and
  `uv run ruff check . && uv run pyright && uv run pytest tests -q && uv run pytest python -q`
  must pass at the end of each workstream.
- No behavior changes without tests. No new dependencies outside the
  `check-repo.mjs` allowlist.
- One PR per workstream unless noted; keep commits per logical change.

---

## WS-A — Identity: one product, one name

**Gated by:** D1 (repo name), D7 (protocol scope).
**Findings:** 1.1–1.9, 4.8, 10.2.

Scope:
1. Rename root `package.json` from `warrant` to `fusionkit-monorepo` (private),
   fix its description.
2. Sweep-replace `velum-labs/handoffkit` repository URLs in all
   `packages/*/package.json`, `release/npm-packages.json`
   (`canonicalRepository`), `.github/workflows/*` repo guards, and the docs site
   GitHub link — target the D1 repo slug.
3. Regenerate registry data after updating the OpenRouter `HTTP-Referer` in
   `spec/registry/providers.json` (both TS and Python generated outputs must be
   regenerated via the repo's codegen scripts, not hand-edited).
4. Update schema `$id` base URL per D1 (coordinate with WS-I: schema URLs are
   consumed by protocol package validation).
5. Purge stale `warrant` strings: `scripts/demo.mjs` banner,
   `packages/cli/src/commands/ensemble.ts` `.warrant/` default path,
   `local.ts` header comment, package descriptions saying "Warrant". Keep the
   `WARRANT_*` env-var aliases in `env-compat.ts` working (back-compat) but mark
   deprecated in code docs.
6. Rewrite `CHANGELOG.md` header for FusionKit; backfill real one-line notes for
   0.7.x–0.8.0 from git history.
7. Fill or delete `.github/CODEOWNERS`.

Acceptance: `rg -i 'warrant|handoffkit'` returns only (a) `env-compat.ts`
deprecated aliases, (b) explicitly-retained legacy archive material per WS-B, and
(c) git history references in the changelog.

## WS-B — Legacy excision: get the governance stack out of the product

**Gated by:** D2. This is the highest-risk, highest-value workstream.
**Findings:** 2.1–2.9, 6.9 (partially), 10.1.

Scope (assuming D2 = extract-and-delete; the quarantine variant only changes step 6):
1. **CLI:** delete `registerDeployment` from `packages/cli/src/cli.ts` and remove
   `packages/cli/src/commands/deployment.ts`; drop the `@fusionkit/plane`
   dependency from `cli/src/config.ts` (plane home loading), delete dead
   `clientFor`/`waitForTerminal` in `shared/plane.ts`, and remove the legacy
   `@fusionkit/cli/render` export (used only by governance examples).
2. **tool-claude:** extract the sandbox execution path that imports
   `@fusionkit/runner` + `@fusionkit/session-harness` (either delete if unused by
   the product, or move behind the extracted repo boundary). Remove the dead
   `runner`/`session-harness` deps from `packages/ensemble/package.json`.
3. **adapter-ai-sdk:** split into product surface (`mlxServer`, `MlxEnv`, model
   adapters) and governance surface (`swarmTools`, `remoteTools`, `handoffModel`,
   `routedModel`); the governance surface leaves with the legacy packages.
4. **Delete/extract packages:** `plane`, `runner`, `sdk`, `handoff`,
   `adapter-compute`, `session-hermetic`, `session-vercel-sandbox`,
   `session-harness`; move the governance-only parts of `testkit` with them.
5. **Examples:** remove governance demos 01–14; keep and promote
   `runtime-kernel`, `mlx`, `bench`; add demo coverage of the *fusion* path to
   `test/demos.test.js` (see WS-F for new product examples); update
   `examples/manifest.json` and `scripts/demo.mjs`.
6. **Docker:** remove root `Dockerfile` / `docker-compose.yml` / `.dockerignore`
   (they build the Warrant stack) and the CI docker smoke job.
7. **Specs:** archive the four governance specs out of `spec/` (they leave with
   the extraction); rewrite `spec/2026-06-13-local-model-harness-bridge-spec.md`
   command names to `fusionkit` and move to `docs/specs/`.
8. **Publish set:** trim `release/npm-packages.json` to the ~16 product packages;
   update `check-release-publish.mjs`.
9. Fix `docs/scope.md` to describe the *completed* separation (2.1).

Acceptance: `pnpm why @fusionkit/plane` (and runner/sdk/handoff/session-*) empty
from the CLI closure; `fusionkit --help` shows no governance commands; CI green
without the docker job; publish check passes with the trimmed manifest.

## WS-C — Repo hygiene: delete/move the leftovers

**Gated by:** D2 (spec archive target), D4 (uniroute), D6 (references).
**Findings:** 3.1–3.11, 5.2 (branch artifacts inform .gitignore), 7.1.

Scope:
1. Delete `PRODUCTION_READINESS_AUDIT.md` (internal GTM audit).
2. Gitignore `release/state.json`; delete the committed copy (contains a
   developer machine path); document `release refresh` regeneration in
   `docs/releasing.md`.
3. Per D6: delete `references/` and root `trackcn.json`; add
   `docs/references.md` with pinned upstream commit links (from trackcn.json)
   for sst/opencode and pingdotgg/t3code.
4. Delete root `fusionkit.json` (legacy v1 config; CLI migrates automatically).
5. Move `ENSEMBLE_PRODUCT_PLAN.md` → `docs/planning/ensemble-product-plan.md`
   and `HARNESS_PROMPT_PASSTHROUGH_SPEC.md` → `docs/specs/harness-prompt-passthrough.md`,
   each with a dated "historical plan / implemented spec" banner; fix handoffkit
   references in the latter.
6. Add `.cursor/` to `.gitignore` and remove the committed skills/plans (internal
   agent ops with spend caps); if any skill is genuinely useful to contributors,
   distill it into `docs/` first.
7. Per D4: move `python/uniroute*` out (separate repo) or to a clearly-labeled
   `research/` directory with its own README + license decision.
8. Move `portless.json` under `apps/` (or document it); scrub the four
   `/Users/alen/...` and `velum-mini` paths from docs (3.9) by replacing with
   generic placeholders.
9. Delete `scripts/migrate_runs_to_trajectory.py` (preserve as a migration note
   in docs); decide `simple_*_server.py` (keep only if docs still need them,
   else delete and update docs).

Acceptance: `git ls-files | rg 'references/|trackcn|state.json|PRODUCTION_READINESS'`
empty; `rg '/Users/'` returns no hits outside test fixtures; check-repo manifest
updated; CI green.

## WS-D — TypeScript deep clean: DRY, split god files, kill dual paths

**Depends on:** WS-B (so refactors don't churn code that's being deleted).
**Findings:** 6.1–6.8, 6.10.

Scope:
1. Split `model-gateway/src/fusion-backend.ts` (2,041 ln) into
   `fusion-session.ts`, `fusion-failover.ts`, `fusion-proxy.ts`, shared SSE wire
   helpers (merge with `frontdoor/sse.ts`, resolving finding 6.6), and a thin
   `FusionBackend` facade. Replace its 11 raw `console.*` calls with an
   injectable logger consistent with the CLI presenter contract.
2. Split `kernel/src/runtime.ts` (1,421 ln) into `types.ts` / `engine.ts` /
   `streaming.ts` / `budget.ts`; keep the package zero-dependency. **Write the
   missing kernel test suite** (graph execution, budgets, streaming contracts).
3. Split `ensemble/src/unified.ts` (949 ln) into kind registry, panel
   orchestration, and harness factories.
4. Retire the dual harness path: make `harness-core` drivers the only
   implementation (remove `FUSIONKIT_HARNESS_DRIVERS` flag and legacy
   `harness.ts` bodies in tool-codex/claude/cursor once driver parity is
   test-verified).
5. Extract shared modules: stream-json trajectory parser (tool-claude +
   tool-cursor → `harness-core`), OpenAI chat wire types
   (`adapters/openai-chat-wire.ts`), fused sub-agent builders
   (`tools/src/fused-subagents.ts` with per-tool serializers).
6. Add unit tests for `tools` (registry contract) and `sdk`-replacement surfaces
   that remain after WS-B.
7. Burn down the 9 TODOs: resolve or convert each to a tracked issue reference.

Acceptance: no non-test source file > ~800 lines in product packages; kernel test
suite exists and passes; `rg 'FUSIONKIT_HARNESS_DRIVERS'` empty; duplicate
helpers gone (single definition each).

## WS-E — Python deep clean: packaging correctness + module splits

**Gated by:** D4 (uniroute placement affects workspace config).
**Findings:** 7.1–7.10, 4.3 (uniroute licensing).

Scope:
1. **Fix the wheel (P0):** move `fixtures/` and `benchmarks/` into
   `src/fusionkit_evals/` and load via `importlib.resources` (or configure
   `tool.uv.build-backend` data includes); move `adapters/*.py` under
   `src/fusionkit_evals/adapters/`. Add a packaging test that installs the built
   wheel into a temp venv and runs `fusionkit tiny-bench --help` + a fixture
   load.
2. **PyPI metadata (P0):** add `readme`, `classifiers`, `project.urls`,
   `authors`, `keywords` to all five published pyprojects; give
   `fusionkit-core` a short README.
3. Make `fusionkit-evals` an optional extra (`pip install "fusionkit[evals]"`);
   the CLI lazily imports evals commands and prints an actionable install hint
   when absent.
4. Split `fusionkit_cli/main.py` (1,474 ln) into `commands/` submodules
   (serve/init/auth vs bench/tune/hillclimb); move maintainer commands into a
   `bench` sub-app so default `--help` shows ~5 commands (coordinates with WS-F
   item 5).
5. Split `fusionkit_core/clients.py` (1,649 ln) into per-provider modules plus
   shared retry/SSE/tool-reassembly modules; keep the public `build_client(s)`
   API stable.
6. Relocate root `tests/` into `python/<pkg>/tests/` per the mapping in the
   audit; keep a thin root `tests/` only for cross-package protocol/script
   integration; update `testpaths`, pyright include, and CI invocations.
7. Fix FastAPI `version="0.2.0"` → read from package metadata.
8. Add `.fusionkit/prompts/*.md` loading to the Python config path for parity
   with Node (document precedence: request > YAML > prompts dir > defaults).

Acceptance: wheel-install smoke test passes in CI; `pip install fusionkit`
closure excludes pandas/datasets; PyPI `twine check` shows full metadata; pytest
green under the new layout.

## WS-F — CLI UX: make the front door feel magic

**Depends on:** WS-B (legacy commands removed first).
**Findings:** 8.1–8.9, 2.5 (product demos).

Scope:
1. Re-order command registration so `--help` reads as the user journey: codex /
   claude / cursor / serve, then init / setup / doctor / status, then config /
   prompts / sessions / models / ensemble, then maintainer (`runtime` hidden or
   grouped). Add a 3-line quickstart to root help.
2. `doctor` readiness gate: exit non-zero (or clearly print "almost ready — no
   provider credentials") when zero keys and no Apple-Silicon local path; make
   the `setup` recommendation prominent when the engine isn't cached.
3. **Binary collision (with WS-E):** Node `doctor` detects a Python `fusionkit`
   shadowing on PATH and says which is which; align version flags (`-v`/`-V`
   both work in both CLIs); rename Python `serve` → keep `serve` but make its
   help explicitly say "raw router (the Node CLI drives this for you)" — or
   rename per D-level decision if desired.
4. Single init story: Python `init` points coding-agent users at the Node CLI;
   remove the Node `init` governance-plane trap (`--dir`/`--host`/`--plane-url`)
   along with WS-B.
5. Python CLI IA: maintainer commands under a `bench` group (implemented in
   WS-E item 4); root help string upgraded to sell the product.
6. Rename/clarify `local` vs `--local` (recommend: keep `--local`, rename
   `local` → `solo` with an alias, or at minimum rewrite both help strings to
   disambiguate).
7. Shell completions for bash/zsh/fish; document `FUSIONKIT_*` env vars in a
   `fusionkit help env` section or doctor footer (including deprecated
   `WARRANT_*` aliases).
8. Add 1–2 *product* examples (fused codex/claude quickstart with a mock panel)
   wired into `examples/manifest.json` and the demo acceptance suite, replacing
   the removed governance demos.

Acceptance: fresh-machine walkthrough (scripted in CI where possible: help
output snapshots, doctor exit codes, init scaffold) matches the documented
journey; help snapshots reviewed for tone/consistency.

## WS-G — Documentation: one canonical journey, honest positioning

**Depends on:** WS-A/B/C/F (docs must describe the post-cleanup reality).
**Gated by:** D5 (flagship panel), D1 (domain).
**Findings:** 9.1–9.9, 1.9, 4.10.

Scope:
1. Declare Fumadocs (`apps/docs`) the single user-facing canonical surface;
   convert `docs/quickstart-*.md` into thin pointers (or delete); README links
   point at the site; `docs/` becomes explicitly maintainer-only with a banner
   in `docs/README.md`.
2. README rewrite around the actual value prop: open-weight fusion in your
   existing harness, benchmark table (from WS-K), cost story, badges, demo
   GIF/video, `fusionkit setup` + git-repo prerequisite in the quickstart,
   comparison paragraph vs LiteLLM/OpenRouter/MoA.
3. Purge/rehome legacy docs: delete or archive `architecture.md`, `concepts.md`,
   `operations.md`, `examples.md`, `handoff-sdk.md`,
   `fusionkit-handoff-executor.md`, `handoffkit-fusion-bench.md` (per D2);
   remove the "Governed execution" card and Self-Hosting/Handoff-SDK pages from
   the public site; rename `operations-and-scripts.md` → `repo-operations.md`.
4. Fix every accuracy bug from finding 9.5 and re-verify: scope.md, prompts
   `--dir`, schema v3 examples, command prefixes.
5. `docs/fusion/`: label or relocate internal artifacts
   (`MOA_IMPLEMENTATION_PROMPT.md` deleted; `incomplete-work-inventory.md`,
   `STABILIZATION.md` marked internal or moved); update
   `documentation-taxonomy.md`'s inventory to match reality.
6. Complete the Fumadocs CLI reference (config get/set, prompts, ensemble CRUD,
   version) and add a glossary entry for the dual model ids
   (`fusion-panel` vs `fusionkit/panel`) and the two meanings of "handoff"
   (rename the legacy one in prose).
7. Add FAQ + troubleshooting links from README; add a migration note
   (config v1→v3; repo rename).
8. Add a CI drift check: `docs/cli.md` / Fumadocs command page vs
   `fusionkit --help` output.

Acceptance: a newcomer path README → site quickstart → CLI ref → config →
troubleshooting exists with no legacy detours; spot-check of 10 doc claims vs
source finds zero discrepancies.

## WS-H — Community & policy files (independent, can start immediately)

**Findings:** 4.1, 4.2, 4.3, 9.3.

Scope:
1. Rewrite `SECURITY.md`: supported versions (latest minor), private disclosure
   via GitHub Security Advisories, scope (CLI + gateway + Python router), data
   handling pointer, supply-chain posture summary.
2. Add `CONTRIBUTING.md` (dev setup from README's Development section, the
   check-repo manifest rule, codegen commands, test matrix, dependency
   allowlist policy, commit/PR conventions) and `CODE_OF_CONDUCT.md`
   (Contributor Covenant 2.1).
3. `.github/ISSUE_TEMPLATE/` (bug, feature, docs) + PR template; optional
   FUNDING.yml per owner.
4. Add root `NOTICE` (Velum Labs copyright + any third-party attributions that
   remain after WS-C).
5. Add LICENSE files to `packages/harness-core` and `packages/runtime-utils`;
   add `"license": "Apache-2.0"` to `spec/model-fusion-contract/package.json`.
6. Package metadata polish: `keywords` on all published packages; short READMEs
   for the ~14 published packages that lack one (npm page = package README).

Acceptance: GitHub community-standards checklist fully green; every published
artifact (npm + PyPI) carries license + readme + keywords.

## WS-I — CI/CD for a public repo

**Depends on:** WS-A (repo slug), WS-B (removed docker/demo gates).
**Findings:** 10.1–10.5, 4.10.

Scope:
1. Restructure `ci.yml` into product-only gates (check, build, unit tests,
   product demos, ootb CLI smoke, Python lint/type/test, contract validation);
   the docker warrant job is deleted with WS-B.
2. Update repo guards in the three release workflows to the D1 slug; verify a
   dry-run publish path.
3. Add CodeQL (JS/TS + Python) and a `uv`/pip ecosystem to dependabot.
4. Remove stale `PACKAGES_READ_TOKEN` references (check-repo, Dockerfile is
   deleted, protocol consumption docs updated).
5. Ensure fork PRs run CI without secrets (already true — keep it that way; add
   a comment in the workflow).
6. Optional: a macOS runner job for MLX smoke, or a documented "not CI-tested"
   note.

Acceptance: green CI on a scratch fork of the post-cleanup tree; release
workflows dry-run cleanly under the new slug.

## WS-J — Privacy & data-handling disclosure

**Depends on:** D5; pairs with WS-G.
**Findings:** 4.4–4.7.

Scope:
1. Replace the committed `.fusionkit/fusion.json` per D5 (either the documented
   default trio or a clearly-labeled open-weight OpenRouter panel with a
   comment + README callout that it routes through OpenRouter and requires
   `OPENROUTER_API_KEY`).
2. Write `docs/privacy.md` (linked from README + SECURITY.md): what
   `~/.fusionkit/sessions` stores (full message arrays incl. code), retention
   and `sessions rm`, no telemetry/phone-home (affirmative statement), which
   providers see your code per panel config, and the rate-limit failover
   expansion behavior (default `onRateLimit: fusion` re-sends the turn to panel
   providers).
3. Add a first-run notice: when the effective config routes through an
   aggregator (OpenRouter/AI-Gateway) the cost-consent prompt names it
   explicitly.

Acceptance: privacy doc exists and is linked; consent prompt names the actual
egress destinations; committed config matches documented default.

## WS-K — Benchmark evidence for the headline claim

**Gated by:** D5; runs after WS-D/WS-E stabilize (billed run).
**Findings:** 11.1–11.3, 9.4.

Scope:
1. Define the flagship open-weight panel (per D5) and lock a held-out public
   benchmark split per the existing `fusion-hillclimb` / `public-bench`
   machinery and `docs/fusion/FUSION_VALUE_RUBRIC.md`.
2. Run the billed benchmark (owner-provided keys and spend cap) comparing:
   fused open-weight panel vs each panel member vs the frontier baseline table
   in `public_bench.py` — quality *and* $ cost per task.
3. Publish `docs/benchmarks.md` (methodology, exact configs, commit hash, raw
   artifacts) + the summary table in the README; label externally-sourced
   baseline numbers as such.
4. Promote the reproduction path: one documented command to re-run the public
   suite.

Acceptance: README table backed by a committed, reproducible artifact; every
number traceable to a run config + commit.

## WS-L — Publish operations (final, human-supervised)

**Gated by:** D1, D3; runs last.
**Findings:** 5.1–5.4, 10.2.

Scope:
1. Per D3: either (a) fresh-start — new repo, squashed initial commit from the
   cleaned tree, re-tag from 0.9.0; or (b) publish `main` history — then
   **delete or keep-private all 43 side branches** (they contain billed audit
   artifacts and a spend ledger), review the 25 `handoffkit-v*` tags (recommend
   deleting from the public remote; releases live on npm/PyPI), and confirm no
   deleted-file secrets (verified clean for main).
2. Verify npm `@fusionkit` org and PyPI project ownership; set up the public
   docs domain per D1.
3. Repo settings: branch protection on `main`, required CI checks, secrets
   scanning + push protection enabled, Discussions on/off per owner.
4. Final pre-flip sweep: re-run the secret/PII grep suite from the audit on the
   final tree; GitHub community-standards check; fresh-clone quickstart test on
   a clean machine (the ultimate DX gate).

Acceptance: public repo shows only the cleaned `main` (+ release tags per D3),
all checks green, fresh-clone `npm i -g @fusionkit/cli && fusionkit codex`
walkthrough succeeds as documented.

---

## Suggested agent allocation

| Wave | Workstreams (parallel) | Notes |
| --- | --- | --- |
| 0 | Owner answers D1–D7 | Everything below assumes answers |
| 1 | WS-H, WS-C, WS-A | Independent of each other; small merge conflicts at root files — land WS-C first if serializing |
| 2 | WS-B | Single agent, biggest diff; everything downstream rebases on it |
| 3 | WS-D, WS-E, WS-F | Parallel: TS refactor, Py refactor, CLI UX (WS-F coordinates with WS-E on the Python CLI split) |
| 4 | WS-G, WS-I, WS-J | Docs/CI/privacy against the stabilized tree |
| 5 | WS-K | Billed benchmark run |
| 6 | WS-L | Human-supervised publish |
