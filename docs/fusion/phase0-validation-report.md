# Phase 0 Validation Study — Results and Decision

**Executes:** §19 Phase 0 of `docs/fusion/capability-index-spec.md`
**Analysis artifacts:** `analysis/phase0/` (this document is the decision
record; the per-checkpoint reports hold the full tables and methods)
**Billed spend:** $5.56 by ledger (`c3_spend_ledger.jsonl`, charged-cost sum;
the pilot report's $6.41 figure came from a metrics-side aggregation that
double-counts some OpenRouter estimates — the discrepancy is conservative)
of the $60 pilot cap ($250 recommended ceiling)

**Independent verification:** all decision-driving numbers in this document
were recomputed from the committed CSV/JSON artifacts by a second pass
(per-model pass rates + Wilson CIs, panel oracle/headroom, bootstrap CIs,
capture, spend ledger); the C3 script was audited to confirm it grades via
the real `fusionkit-evals` path (`verify_solution` + `LocalSandbox` +
`extract_code` over `livecodebench_data` tasks), and the C2 pre-registration
was checked for consistency with the executed analysis (one recorded
deviation: a base-engine parser correction).

---

## Checkpoint results

| Checkpoint | Question | Verdict | Key number |
|---|---|---|---|
| **C0** — coverage | Do deployable models have per-task public data? | **PARTIAL** | Terminal-Bench covers the deployable agentic frontier (52k trial rows, GPT-5.5/Opus-4.x/Gemini-3-class systems); LLMRouterBench covers near-deployable variants at tier A; LiveBench/BigCodeBench lag the frontier |
| **C1** — existence | Do strong systems make complementary errors? | **PASS** | Headroom over best single: +9.0pp CI [+6.5, +12.5] (SWE-bench Verified, system-level); +12.3pp [+7.6, +14.9] (Terminal-Bench); +11.3pp [+9.3, +12.2] (LLMRouterBench LCB, tier A); floors met |
| **C2** — selection value | Does complementarity-selected beat top-K-by-average out of sample? | **INCONCLUSIVE / FAIL** | No held-out Δ_oracle CI lower bound > 0 anywhere; V-selection re-test also found no positive Δ_V CI and SWE-bench Verified remained negative |
| **C3** — transfer | Does public signal transfer to our harness? | **PASS, then REVISED by 16k re-run** | Original 4k-budget run: +5.1–7.0pp headroom, sign agreement **10/10**, judged replay beat best single. **16k re-run, same 60 tasks (`c3r16k_report.md`):** gpt-5.5 48.3%→**80.0%** (the 4k cap was truncating it on 26/60 tasks); all panel headroom collapses to **+1.7pp [0.0, +5.0]**; the slice is *lopsided* (gpt-5.5 +38pp over next). Sign transfer stands; the quantitative headroom evidence on this slice does not |

Sources: `analysis/phase0/c0_coverage.md`, `c1_c2_report.md`,
`c2_preregistration.md`, `c2v_preregistration.md`, `c2v_report.md`,
`c3_plan.md`, `c3_transfer_report.md`, `c3r16k_report.md`,
`harness_inventory.md`, `cost_table.md`.

## What the evidence says, plainly

1. **The fusion thesis is supported where models are peers — and refuted
   where they are not.** Complementary errors are real and material among
   public systems of comparable strength (C1: +8–12pp headroom across three
   sources). But the corrected C3 measurement (16k re-run) shows our
   deployable slice is **lopsided**: with gpt-5.5 measured properly at 80%,
   no panel offers more than +1.7pp [0.0, +5.0] of selection headroom on
   single-shot algorithmic tasks in that window. The honest routing answer
   there is *single model, don't fuse* — which is exactly the kind of
   answer this system exists to produce, and it echoes the repo's own
   lopsidedness warning (`LOPSIDED_SCORE_GAP`). Two things keep the fusion
   thesis alive: (a) peer panels on harder/agentic domains (where C1
   headroom lives), and (b) synthesis-style fusion, which the original
   run's replay showed can *exceed* the candidate-selection ceiling —
   lopsidedness caps selection, not synthesis. Contamination caveat: the
   2025-02..04 task window likely predates gpt-5.5's cutoff, which may
   inflate its measured dominance.
2. **Public per-task data predicts *structure*, not *rankings*.** The
   failure-dependence signs transferred 10/10 from public data to our
   harness. But selecting panels by train-split complementarity did **not**
   beat the dumb top-K-by-average baseline out of sample anywhere in public
   data, and lost outright on SWE-bench Verified. Oracle-on-train selection
   overfits; average-score selection is a genuinely strong baseline. The
   follow-up C2V re-test used the spec objective
   `V(S) = best_pass + 0.7×headroom` on the same held-out splits: it found
   no positive Δ_V CI, 2/14 panels identical to the top-K baseline, no
   capture-sensitivity panel changes, and SWE-bench Verified still negative.
   C2 is therefore settled for public-prior selection under both oracle-only
   and value selection, subject to the public-data limitations below.
3. **Coverage is adequate for priors, inadequate for authority.** The
   deployable frontier appears in public per-task data mostly as
   scaffold-confounded A− rows (Terminal-Bench, SWE-bench submissions) or
   near-version variants (LLMRouterBench's gpt-5/claude-sonnet-4/kimi-k2
   rather than our exact deployables).
4. **Calibration is cheap where the harness already works.** The full C3
   pilot — 5 models × 60 tasks + a judge replay — cost $6.41. The binding
   constraint is not money for algorithmic-domain calibration; it is
   harness coverage: only the algorithmic domain is runnable end-to-end
   today (`analysis/phase0/harness_inventory.md`); repo_bugfix needs the
   HandoffKit patch-and-test path hardened, and frontend/data_sql/security
   graders don't exist.

## Decision

Per the spec's §19 outcome rules (C2 fail → descope selection authority;
C3 pass → priors remain useful):

**Build the reduced index — "shortlist + calibration-first" — not the full
public-prior selection machinery.**

Concretely, relative to the spec:

- **Build (M1, reduced):** the warehouse core (schemas, connectors for
  SWE-bench experiments + LLMRouterBench + Terminal-Bench, identity
  resolution, quality report). These earn their keep for coverage tracking,
  calibration-slice design, and dependence-sign priors.
- **Build (M5 first, not last):** the calibration loop is the *primary
  engine*, not the validator. Panel selection authority comes from
  tier-CAL rows; the C3 pilot machinery (`analysis/phase0/scripts/
  c3_transfer_pilot.py`) is the seed of `calibration.py`.
- **Demote:** `select.py`'s public-prior selection paths. Public data may
  *shortlist* candidates and *veto* high-correlation pairs (the sign
  transfer justifies exactly that much); it may not rank or pick final
  panels. Cards ship as evidence reports until calibrated.
- **Defer indefinitely:** aggregate-proxy diversity selection, LiveCodeBench
  artifact hunt (S1), preference ingestion (S9), the learned router.
- **New priority surfaced by C3:** the judged replay beating the frozen
  bank's oracle (capture > 100% via synthesis) says judge/synthesis design
  — not panel membership — may be where the fusion value concentrates.
  That is measurable with the existing hill-climb machinery and should be
  the second calibration round's focus.

## Panel guidance from this study (interim, calibration-backed)

Updated after the 16k re-run (`c3r16k_report.md`), which corrected the
truncation artifacts:

- **Single-shot algorithmic (this slice): don't fuse.** `gpt-5.5` measured
  80.0% [68.2, 88.2] — +38pp over the next model — and no panel offers more
  than +1.7pp [0.0, +5.0] of selection headroom. Route single-model.
  (Contamination caveat: pre-cutoff task window; re-check on a post-cutoff
  slice before hardening this into policy.)
- **The committed default panel (`kimi-k2-thinking` + `qwen3-coder`) is not
  competitive on this workload shape**: its panel oracle is 31.7% vs
  gpt-5.5 alone at 80.0%. However, kimi-k2-thinking is *still* not validly
  measured — 52/60 of its completions hit even the 16k cap (sonnet also
  truncated 14/60, so its 41.7% is a floor). A ≥32k-budget or
  reasoning-capped re-measure is needed before final judgment on the
  default panel's members.
- **Where fusion still has a case:** peer panels on harder/agentic domains
  (C1's +8–12pp headroom lives there), and synthesis-style fusion (the
  original replay exceeded the selection oracle). Both are exactly what the
  next calibration round should target — agentic/repo tasks and a
  synthesis-focused judge protocol — rather than more single-shot
  algorithmic slices.

## Layer-3 signal decision (pre-work item, §Phase-0)

Production tasks have no ground truth, so Layer-3 can support only: cost and
latency actuals, route distribution, and *proxy* quality signals. Options
considered: (a) user acceptance/edit-retention of fused output where the
product surface exposes it; (b) post-hoc test execution when the user's repo
has tests; (c) nothing yet. **Decision: (c) with instrumentation.** No
current product surface reliably captures (a) or (b). Layer 3 is therefore
scoped to cost/latency/drift-alarm duty only, and the router milestone (M6)
is re-scoped accordingly: router *regret* is measurable only on calibration
slices, not in production, until an acceptance signal exists. This is a
product gap to revisit, not an index task.

## Costs and budget going forward

From `analysis/phase0/cost_table.md` and the C3 actuals: algorithmic-domain
calibration is ~$0.02/task/model single-shot (measured); a full 300-task ×
4-system round including judge replay stays under ~$50 measured for
single-shot domains. Agentic repo-domain calibration remains the expensive
unknown ($1–10/task estimated) and is blocked on harness work, not budget.

## Immediate next steps

1. ~~Re-run the C3 slice with a larger completion budget~~ **Done**
   (`c3r16k_report.md`, $10.62): gpt-5.5 80%, slice lopsided, headroom
   +1.7pp; kimi still truncating at 16k.
2. ~~Re-test C2 with V-selection~~ **Done** (`c2v_report.md`, free): no
   positive Δ_V anywhere; C2 fully settled — no public ranking authority.
3. **Post-cutoff contamination check** (~$10): re-run the 5-model slice on
   the newest available LCB window (or newly published contest tasks) to
   confirm gpt-5.5's dominance isn't training-set leakage.
4. **Thinking-model measurement fix**: re-measure kimi-k2-thinking (and
   sonnet) with ≥32k budget or provider reasoning caps before final default-
   panel judgment (~$8, kimi+sonnet only).
5. Harden the C3 pilot script into `calibration.py` + the
   `CandidateBank → tier-CAL` adapter (spec §15.3); the first real
   calibration round should target **agentic/synthesis fusion value**, not
   more single-shot algorithmic slices (that question is answered: don't
   fuse there).
6. Start M1 (reduced warehouse) with the three sources that produced
   evidence; port the Phase-0 scripts as reference implementations.
7. Harness work for repo_bugfix calibration (HandoffKit patch-and-test
   path) — the highest-value unlock: repo tasks are the product's core,
   the public A− data is densest there, and C1 says that's where peer-panel
   headroom lives.
