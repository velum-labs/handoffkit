# Capability Index Program — History and Decision Log

> **Document role: append-only.** New stages and decisions are appended;
> existing entries are never rewritten (corrections are new entries). The
> *current* state of the program — beliefs, binding scope, next steps —
> lives in `capability-index-status.md`, which supersedes anything here on
> conflict.

**Started:** 2026-07-04
**Branch/PRs:** `cursor/capability-index-report-c275` — PR #53 (analysis,
merged), PR #54 (spec + Phase 0 execution)
**Billed spend to date:** ~$17.5, ledger-tracked
(`analysis/phase0/c3_spend_ledger.jsonl`)

---

## 1. Chronology of work

### Stage 1 — Critical analysis (`coding-capability-index-report.md`, PR #53, merged)

Compared two prior artifacts — an externally drafted *Coding Model Router
Benchmark Plan* and the `model-area-index` package from PR #52 — against
the product goal of a **capability index** (task-level evidence warehouse
feeding ensemble panel selection), and specified the optimal synthesis.
Key conclusions that shaped everything after:

- The plan had the right methodology (evidence tiers, comparability
  controls, statistics) but no implementation and a scope problem; PR #52
  had the right warehouse substrate but committed source-as-taxonomy and
  discarded per-task evidence at ingestion.
- The correct unit of evidence is the per-task **outcome** (task × system ×
  harness), with the task as join key; complementarity math requires it.
- Three-layer evidence architecture: public priors → calibrated runs →
  production telemetry, with layer-scoped authority.

### Stage 2 — Implementation specification (`capability-index-spec.md`)

A self-contained, from-scratch buildable spec: pydantic data model
(`BenchmarkTask`, `TaskOutcome`, `AggregateScore`, `PairwisePreference`),
taxonomy with an executable label-retention test, nine per-source ingestion
specs, identity resolution, statistics (Wilson/shrinkage/anchor-linking/φ),
top-K selection with judge-capture discount, panel cards, calibration
bridge into `fusionkit-evals`, router staging, milestones, risk register.

### Stage 3 — Build order (spec §19)

Added the construction chronology: notebook-scale validation study first,
walking skeleton, parallel tracks, and explicit go/no-go checkpoints.

### Stage 4 — Red-team (three independent GPT-5.5 reviewers)

Statistics/methodology, data-engineering, and product/strategy reviews.
All findings folded into the spec, most importantly:

- **Validation-study-first chronology** with four checkpoints (C0
  deployable coverage, C1 decorrelation existence, C2 pre-registered
  selection-beats-average, C3 billed same-harness transfer pilot) placed
  *before* any package build, with descope paths per failure.
- Connector manifests replacing naive URL fetching; richer row identity
  (submission/run/trial/sample); per-right license model.
- Statistics repairs: corrected capture definition
  `(p_fused − p_best)/(p_oracle − p_best)`, φ sample-size floors + clustered
  bootstrap, exhaustive small-K selection instead of an overstated greedy
  guarantee, two-slice calibration design (random estimation + active
  diagnostic), selection-regret as the self-validation gate.
- Verified factual fixes: the `CandidateBank` adapter shape
  (`task.candidates`, not `pass_by_model`), `BenchmarkPanel`'s
  judge-must-be-member constraint, real source access paths (S3 logs,
  HF pagination, release assets).

### Stage 5 — Phase 0 execution (GPT-5.5 subagents, orchestrated + verified)

| Artifact | What it did |
|---|---|
| `analysis/phase0/c0_coverage.md` | Deployable-model coverage across SWE-bench experiments, LLMRouterBench, LiveBench, BigCodeBench, Terminal-Bench. **PARTIAL** — Terminal-Bench covers the deployable agentic frontier; per-task tier-A data mostly covers near-deployable variants |
| `analysis/phase0/harness_inventory.md` | What `fusionkit-evals` can execute per domain today: only `algorithmic` end-to-end; repo_bugfix partial via HandoffKit path; frontend/data_sql/security graders missing |
| `analysis/phase0/cost_table.md` | Per-domain cost scenarios; C3 pilot cap $250 recommended (actual spend came in far under) |
| `analysis/phase0/c2_preregistration.md` + `c1_c2_report.md` | Pre-registered C1/C2 on 7 source×subset matrices. **C1 PASS** (headroom +8 to +12pp, CIs excluding 5pp, floors met). **C2 FAIL/INCONCLUSIVE** (complementarity-selected panels never beat top-K-by-average out of sample; −3.0pp on SWE-bench Verified) |
| `analysis/phase0/c3_plan.md` + `c3_transfer_report.md` | Billed pilot: 5 models (gpt-5.5, claude-sonnet-4-6, kimi-k2-thinking, deepseek-chat, qwen3-coder) × 60 LiveCodeBench tasks under the real harness (`verify_solution` + `LocalSandbox`), $5.56. Apparent +5–7pp panel headroom; failure-dependence sign agreement public↔calibrated **10/10**; judged replay 38.6% vs best single 28.1% |
| `docs/fusion/phase0-validation-report.md` | Decision record (later revised — see stages 6–7) |

### Stage 6 — Independent verification

Every decision-driving number recomputed from committed artifacts; the C3
script audited for real grading. Three findings:

1. **kimi-k2-thinking's 5.2% was a measurement artifact** — 51/58
   completions hit the 4096-token cap (thinking consumed the budget before
   code was emitted).
2. Spend bookkeeping: ledger $5.56 vs reported $6.41 (conservative
   direction; metrics-side double count).
3. **C2's pre-registered selector was oracle-only** — the spec's value
   objective V(S) had not been tested, so C2 was not yet settled.

### Stage 7 — Follow-up experiments (closing the loopholes)

| Experiment | Cost | Result |
|---|---|---|
| **C2V** — V-selection re-test on cached public matrices (`c2v_report.md`) | $0 | **C2 settled.** V-selection also never achieves a positive held-out ΔV; still loses on SWE-bench Verified (−2.9 to −3.5pp); insensitive to capture ∈ [0.5, 0.9]. Design lesson: with `best_pass` a max and no cost term, V degenerates toward oracle-seeking and still admits weak decorrelated members |
| **C3-R16K** — same 60 tasks re-run at 16k completion budget (`c3r16k_report.md`) | $10.62 | **The original headroom PASS was substantially a truncation artifact.** gpt-5.5: 48.3% → **80.0%** [68.2, 88.2] (it had been truncated on 26/60 tasks). The slice is *lopsided* (+38pp over next model); every panel's headroom collapses to +1.7pp [0.0, +5.0]. Sign transfer stands. kimi-k2-thinking still truncates at 16k (52/60) — remains unmeasured |

Operational note: the C3-R16K run took ~3 hours wall-clock (concurrency 1 ×
thinking-model latency × 5 models × 60 tasks) and outlived its subagent
session; it was recovered from its tmux session, completed cleanly (exit 0),
and analyzed. Future long runs: concurrency 3–4 + periodic checkpointing.

### Stage 8 — Strategy re-think: OSS-first product framing and launch funnel (2026-07-05)

A product-level brainstorm reframed the program around the actual launch:
a CLI where users build their own ensembles or consume our predefined,
evidence-backed ones, with the value proposition "frontier-class coding
performance at OSS prices." Two structural consequences:

- **OSS-first panels (D8).** Ensembles are built from OSS models; closed
  frontier models become routing baselines and price anchors rather than
  panel members. This re-weights the Phase-0 evidence favorably: the
  strongest C1 headroom lived in OSS-heavy peer fields (+11.3pp LCB,
  +23pp MBPP-class), while the "don't fuse" verdict was driven by a
  closed model (gpt-5.5) that is no longer a candidate member. It also
  re-frames product claims as **Pareto claims** (score *and*
  cost-per-solve) instead of saturation claims.
- **The matching problem was re-framed as a funnel (D9).** Instead of
  trying to compute optimal panels from public data (falsified by C2/C2V),
  the plan is a staged filter: free public-data scan → ~$30 calibration
  pilots measuring *fused* performance (capture rate) → full official
  benchmark only for survivors → launch card. Rigor is staged to match
  the money at risk. Full plan: `docs/fusion/oss-ensemble-launch-plan.md`.

The centerpiece measurement is the **capture pilot** (plan Step 3): fused
OSS panel vs best member vs frontier baseline vs oracle on one slice —
the first direct measurement of synthesis capture under a leak-free judge
protocol, and the number the launch claim rests on.

### Stage 9 — Launch-plan Steps 1–2 executed (2026-07-05, GPT-5.5 subagents + verification)

**Step 1 — OSS peer-field scan** (`analysis/oss-scan/`, $0, public data):
six domains scanned with OSS-only universes, lineage annotations, and
veto flags. Every covered domain is peer-shaped once closed models are
excluded (#1–#2 gaps +1.7 to +9.2pp); OSS-only oracle headroom is +11.3pp
(LCB), +17.0pp (repo bugfix model-level, the recommended pilot), +13.0pp
(SWE system-level), +13.5pp (terminal), +22.7pp (MBPP-class). SWE-bench
Test had no adequate OSS universe. Recommended capture-pilot seed: repo
bugfix, deepseek-r1-0528 + deepseek-v3.1-terminus +
qwen3-235b-a22b-thinking-2507 (kimi-k2-0905 alternate), anchor
claude-opus-4.1. Key panel numbers were independently recomputed from the
cached matrices before adoption.

**Step 2 — Thinking-model measurement ladder**
(`analysis/thinking-32k/`, $16.51 ledger-tracked, pre-registered):
same 60-task manifest as C3-R16K. sonnet (claude-sonnet-4-6) at 32k:
**45.0% [33.1, 57.5], 0/60 truncated — first valid measurement** (up from
a truncation-suspect 41.7% at 16k). kimi-k2-thinking stayed
truncation-invalid at every rung — 52/60 (16k), 42/60 (32k), 31/60 (64k,
mean 49k completion tokens) — and is per the pre-registered rule
**not measurable at practical budgets** on single-shot algorithmic tasks
(pass rate rose 11.7% → 21.7% → 28.3% with budget, so published Kimi
scores on such tasks reflect token budgets as much as ability).
Operational notes: one sonnet task (arc192_e) never returned inside a 3h
hard timeout and counts as a fail; a handful of OpenRouter provider
failures (JSON truncation, one "thinking mode not supported" provider
routing miss) were cured by targeted re-runs.

Decision consequences recorded as D10/D11 below.

---

## 2. Results as of Phase-0 close (2026-07-04)

| Question | Answer | Confidence |
|---|---|---|
| Do strong systems make complementary errors? | **Yes** — +8–12pp oracle headroom among peer systems on SWE-bench, Terminal-Bench, LLMRouterBench (C1) | High (three sources, CIs, floors met) |
| Can public per-task data *pick* panels? | **No** — neither oracle-selection nor the spec's V-selection beats top-K-by-average out of sample; sometimes worse (C2 + C2V) | High (pre-registered, two objectives, seven matrices) |
| Does public structure transfer to our harness? | **Signs yes (10/10), magnitudes no** — dependence signs replicated; headroom magnitudes did not survive measurement correction (C3 + C3-R16K) | Medium-high (one domain, one slice) |
| Should we fuse on single-shot algorithmic tasks? | **No — route single-model (gpt-5.5)**: the slice is lopsided (+38pp), panel headroom +1.7pp [0.0, +5.0] | Medium (pre-cutoff task window; contamination check pending) |
| Where does fusion still have a case? | Peer panels on agentic/repo domains (where C1 headroom lives) and **synthesis-style fusion** — the original replay *exceeded* the candidate-selection oracle (38.6% fused vs 35.1% oracle), and lopsidedness caps selection, not synthesis | Directional (needs a dedicated round) |
| Is the committed default panel (`kimi-k2-thinking` + `qwen3-coder`) right? | **Not for this workload shape** (panel oracle 31.7% vs gpt-5.5 alone 80.0%) — but kimi remains unmeasurable below ≥32k budgets, so the member-level judgment is provisional | Medium |

## 3. Interpretation at Phase-0 close

1. **The fusion thesis survives, but narrower and sharper than assumed.**
   Complementarity is real among *peers*. When one model dominates a
   workload (as gpt-5.5 dominates recent single-shot LCB), selection-style
   fusion has nothing to select — the honest product answer there is a
   router that *doesn't* fuse. The capability index's most valuable output
   so far is precisely that negative answer.
2. **Public benchmark data is a compass, not a map.** It reliably tells you
   *which model pairs fail together* (sign transfer 10/10) and who belongs
   on a shortlist; it cannot rank panels — every attempt to extract ranking
   authority from it failed a pre-registered out-of-sample test. This
   settles the biggest design question in the spec in favor of the reduced,
   calibration-first build.
3. **Measurement infrastructure is where studies die.** The single most
   consequential number of the program (gpt-5.5's 80%) was hidden behind a
   completion-budget artifact that made it look like 48%, and an apparently
   solid +7pp headroom evaporated when it was fixed. Without independent
   verification and the re-run, the program would have shipped a wrong
   panel recommendation with confident CIs attached. Truncation accounting
   is now a binding spec requirement.
4. **Pre-registration earned its cost twice** — it made the C2 negative
   result undeniable (no post-hoc rescue), and it made the C3 revision
   clean (same 60 tasks, paired).
5. **Synthesis is the open frontier.** The one result that *exceeded*
   theoretical selection limits was a synthesizing judge. If it replicates
   under a clean protocol, fusion value concentrates in judge/synthesis
   design rather than panel composition — a materially different product
   emphasis than the program started with.

## 4. Where every artifact lives

```
docs/fusion/
  coding-capability-index-report.md   Stage 1: critical analysis (merged, PR #53)
  capability-index-spec.md            Stages 2–4: spec + red-team amendments
                                      + post-validation addendum (binding scope)
  phase0-validation-report.md         Stages 5–7: decision record (current)
  capability-index-program.md         This document

analysis/phase0/
  c0_coverage.md (+ CSV sidecars)     C0 coverage study
  harness_inventory.md, cost_table.md Pre-work
  c2_preregistration.md               C1/C2 pre-registration (frozen)
  c1_c2_report.md (+ CSVs)            C1/C2 results
  c2v_preregistration.md, c2v_report.md   C2 V-selection re-test
  c3_plan.md, c3_transfer_report.md   C3 pilot (4k budget)
  c3_outcomes.csv, c3_metrics.json    C3 raw outcomes + metrics
  c3r16k_report.md, c3r16k_outcomes.csv   C3 re-run (16k budget)
  c3_spend_ledger.jsonl               Complete billed-spend ledger
  scripts/                            collect_c0_coverage.py, analyze_c1_c2.py,
                                      analyze_c2_vselection.py, c3_transfer_pilot.py
  cache/                              (gitignored) cloned sources, banks, logs
```

## 5. Next steps

Maintained in `capability-index-status.md` (living document) — not here,
so there is exactly one place to update as priorities shift.

## 6. Program-level lessons

- **The checkpoint design worked.** Total spend to answer the program's
  three biggest questions was ~$17.5 and one day, *because* the expensive
  build was gated behind falsification tests — two of which (C2, C3
  headroom) failed or revised in ways that would have invalidated months of
  the full build.
- **Verify subagent work by recomputation, not by reading reports.** Both
  material corrections (truncation, C2 scope) came from recomputing numbers
  from raw artifacts, not from reviewing prose.
- **Long-running billed jobs need checkpointing and concurrency by
  default** — one 3-hour sequential run outlived its orchestrating session
  and had to be recovered from tmux.
- **Negative results are product features.** "Don't fuse here, route to X"
  is as monetizable as a panel recommendation, and cheaper to compute.

## 7. Decision log (append-only)

| # | Date | Decision | Basis | Where reflected |
|---|---|---|---|---|
| D1 | 2026-07-04 | Adopt validation-study-first chronology with C0–C3 gates before any package build | Red-team convergence (3 reviewers) | Spec §19 |
| D2 | 2026-07-04 | Build the **reduced** index: shortlist + veto + calibration-first; cancel public-prior panel ranking | C2 FAIL, settled by C2V under both objectives | Status doc; spec addendum |
| D3 | 2026-07-04 | Truncation accounting is a hard calibration requirement (refuse pass-rate claims >~10% truncation; ≥16k budgets for thinking models) | C3-R16K: original headroom PASS was a truncation artifact | Status doc; spec addendum |
| D4 | 2026-07-04 | Single-shot algorithmic routing: single model, don't fuse (provisional on contamination check) | C3-R16K lopsidedness (+38pp, headroom +1.7pp [0, +5]) | Status doc |
| D5 | 2026-07-04 | Next calibration round targets agentic/repo + synthesis-style fusion, not more single-shot slices | C1 headroom location + synthesis-beats-oracle observation | Status doc next steps |
| D6 | 2026-07-04 | Layer-3 scoped to cost/latency/drift only (no production ground-truth signal exists yet); router regret measurable only on calibration slices | Phase-0 pre-work assessment | Phase-0 report; status doc |
| D7 | 2026-07-04 | Document structure: immutable records + living status doc + append-only history/decision log | Sustainability review after three in-place revisions of the Phase-0 report | Status doc "Update protocol" |
| D8 | 2026-07-05 | **OSS-first panels**: closed frontier models are routing baselines / price anchors, not panel members; product claims are Pareto (score + $/solve) | Product direction (cheaper-to-run ensembles) + C1 headroom concentrating in OSS peer fields + C3 lopsidedness being closed-model-driven | Status doc binding scope; launch plan §1, Step 0 |
| D9 | 2026-07-05 | Adopt the staged launch funnel (scan → capture pilot → full benchmark → card) as the active plan; rigor staged to money at risk; contamination check demoted to Step-5 hygiene | Strategy re-think (Stage 8); C2/C2V falsifying public-data matching; $5.56 pilot cost proving calibration is the cheap step | `oss-ensemble-launch-plan.md`; status doc next steps |
| D10 | 2026-07-05 | Capture pilot targets **repo bugfix model-level** with panel seed deepseek-r1-0528 + deepseek-v3.1-terminus + qwen3-235b-a22b-thinking-2507 (kimi-k2-0905 alternate); LCB fallback if patch-and-test grading unavailable | Step-1 scan: largest clean-tier OSS headroom (+17.0pp [+14.3, +20.5]) on the highest-demand domain | `analysis/oss-scan/report.md`; status doc next steps |
| D11 | 2026-07-05 | **kimi-k2-thinking excluded from single-shot panels** — not measurable at practical budgets (truncation-invalid through 64k); any Kimi use must be agentic/multi-turn where per-turn budgets are smaller | Step-2 escalation ladder, pre-registered rule | `analysis/thinking-32k/report.md`; status doc beliefs |
