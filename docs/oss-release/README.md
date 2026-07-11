# Open Source Release Program

## Status (2026-07-05)

Owner decisions received: **no renaming for now** (D1/D7 deferred — repo slug,
npm/PyPI names, scopes, domains, and schema URLs all unchanged) and **no
extraction to private repos** (D2 resolved as isolation: the governance stack
now lives under `legacy/` in this repo). Remediation executed on this branch:

| Workstream | Status |
| --- | --- |
| WS-A identity | Partially executed inside other workstreams (stale `warrant` strings, CHANGELOG, CODEOWNERS); repo/scope renames deferred with D1/D7 |
| WS-B legacy excision | **Done** (as isolation): 8 governance packages, 16 examples, Docker stack, 4 specs moved to `legacy/`; product decoupled; CLI governance commands removed |
| WS-C hygiene | **Done**: root plan docs relocated, `release/state.json` + root `fusionkit.json` + migration script removed, `references/` license compliance, personal paths scrubbed |
| WS-D TS deep clean | **Done**: gateway/kernel/ensemble god files decomposed, shared helpers extracted, kernel + tools test suites added |
| WS-E Python deep clean | **Done**: evals wheel data fixed (verified by installing built wheels), PyPI metadata, CLI split + `bench` group, clients split, prompt parity, tests relocated |
| WS-F CLI UX | **Done**: journey-ordered help + quickstart, doctor readiness gate (exit 1 with no creds), PATH-collision check, completions, env docs |
| WS-G docs | **Done**: fusion-first README, legacy docs quarantined, accuracy fixes, Fumadocs scope cut, taxonomy refresh |
| WS-H community | **Done**: SECURITY/CONTRIBUTING/CoC/NOTICE/templates/CODEOWNERS, missing LICENSEs, package READMEs + keywords |
| WS-I CI/CD | **Done** (public-repo parts): CodeQL, uv dependabot, fork-safety documented, legacy docker job labeled; repo-guard updates deferred with D1 |
| WS-J privacy | **Done**: `docs/privacy.md` + site page, OpenRouter disclosure in README and committed config |
| WS-K benchmarks | **Deferred** (D5): needs owner-approved billed run and flagship panel decision |
| WS-L publish ops | **Deferred** (D3): branch/tag pruning and repo settings are owner-supervised at flip time |


This directory is the working plan for taking FusionKit public. It was produced by a
full-repo audit (repo hygiene, TypeScript workspace, Python workspace, CLI UX/DX,
documentation, and public surface / security) on 2026-07-05. **No code has been
changed yet** — these documents are the contract for the remediation work.

| Document | Contents |
| --- | --- |
| [`audit-findings.md`](audit-findings.md) | Every finding, organized by area, with severity and evidence paths. |
| [`workstreams.md`](workstreams.md) | The remediation plan as 12 orchestration-ready workstreams (WS-A … WS-L), each written as a self-contained brief an agent can execute, with dependency ordering and acceptance criteria. |

## The one-paragraph diagnosis

The fusion product itself is in good shape — strict TypeScript, a real driver
abstraction (`harness-core`), extensive gateway tests, a working PyPI/npm release
pipeline. What is **not** ready is the repository *as a public artifact*: it still
presents as the private `velum-labs/handoffkit` monorepo of a company called Velum
Labs building a governance product called Warrant. Roughly a third of the TypeScript
packages, 14 of 15 examples, the Docker stack, four root-level spec/plan documents,
and large parts of the docs describe that legacy product. The root `package.json` is
literally named `warrant`, `SECURITY.md` says the repo is private, and the stated
product positioning (open-weight fusion beating frontier models on cost) is not what
the README or the default panel config actually say.

## Decisions required from the owner (block workstreams until resolved)

These are product/business decisions the audit cannot make. Each gates one or more
workstreams; everything else can proceed in parallel.

| # | Decision | Recommendation | Gates |
| --- | --- | --- | --- |
| **D1** | Public repo identity: keep `velum-labs/handoffkit` or rename/transfer (e.g. `velum-labs/fusionkit` or a `fusionkit` org)? ~100+ hardcoded references, release workflow guards, schema `$id` URLs, OpenRouter attribution headers, and the docs domain all depend on this. | Rename to a `fusionkit`-named repo before going public; a public repo named `handoffkit` shipping a product named FusionKit is permanent confusion. | WS-A, WS-I |
| **D2** | Fate of the legacy governance stack (`plane`, `runner`, `sdk`, `handoff`, `session-*`, `adapter-compute`, Docker stack, 14 governance examples, 4 dated specs): delete from the OSS tree, extract to a private repo, or keep quarantined? | Extract to a private archive repo and delete from the OSS tree. Quarantine-in-place has already failed once (docs/scope.md claims commands were removed; they were not). | WS-B, WS-C, WS-I |
| **D3** | Git history: publish existing history (25 `handoffkit-v*` tags, personal emails, a Tailscale-hostname committer email) or fresh-start with a squashed initial commit? Main history is small (7.9 MiB) and contains no secrets, but **the 43 remote branches contain internal billed-benchmark artifacts and a spend ledger** (`audit/…/bank-slim.json`, `analysis/phase0/c3_spend_ledger.jsonl` on `cursor/fusion-production-audit-c70f` and similar). | Publish `main`'s history if desired, but **never push the side branches to the public remote**; prune them and review tags. Fresh-start is the simpler, safer option if D1 results in a new repo anyway. | WS-L |
| **D4** | `python/uniroute` + `python/uniroute-mlx` (UNLICENSED research code, zero coupling to FusionKit): move to a separate repo, relicense, or keep labeled as research? | Move out; UNLICENSED packages in an Apache-2.0 repo invite license confusion. | WS-C, WS-E |
| **D5** | Default panel & positioning: the stated product story is *open-weight fusion at lower cost than frontier*, but the built-in default panel is the frontier trio (`gpt-5.5` / `claude-sonnet-4-6` / `gemini-2.5-pro`) and the committed `.fusionkit/fusion.json` silently routes through OpenRouter. What is the canonical out-of-box panel, and what benchmark evidence backs the headline claim? | Make an open-weight panel the flagship documented configuration, keep the frontier trio as an alternative, and publish a reproducible benchmark table before launch (WS-K). | WS-G, WS-J, WS-K |
| **D6** | `references/` (284 vendored files from sst/opencode and pingdotgg/t3code, no licenses attached, one real-looking personal email in a fixture): delete or license-comply? | Delete; replace with pinned upstream links. It is study material, not build input. | WS-C |
| **D7** | `@velum-labs/model-fusion-protocol` npm scope: keep or rename to `@fusionkit/…`? | Rename during D1 for a coherent public namespace. | WS-A, WS-I |

## Execution model

Once the go is given, workstreams are dispatched to parallel agents per
[`workstreams.md`](workstreams.md). The dependency graph is:

```
D1..D7 (owner) ──► WS-A identity ──┐
                   WS-B legacy excision ──► WS-D TS quality ──► WS-K benchmarks
                   WS-C hygiene    ──┘          WS-E Py quality
                   WS-H community  (independent)
                   WS-I CI/CD      (after WS-A/WS-B land)
                   WS-F CLI UX     (after WS-B removes legacy commands)
                   WS-G docs       (last big pass, after A/B/C/F stabilize)
                   WS-J privacy    (with WS-G)
                   WS-L history/publish ops (final, human-supervised)
```
