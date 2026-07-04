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
| **C3** — transfer | Does public signal transfer to our harness? | **PASS** | Pre-named panels: +7.0pp headroom CI [+1.7, +10.5] (P1/P3), +5.1pp [0.0, +12.5] (P2) on 60 LCB tasks × 5 models; failure-dependence sign agreement public↔calibrated **10/10**; judged replay beat best single (38.6% vs 28.1%) |

Sources: `analysis/phase0/c0_coverage.md`, `c1_c2_report.md`,
`c2_preregistration.md`, `c2v_preregistration.md`, `c2v_report.md`,
`c3_plan.md`, `c3_transfer_report.md`, `harness_inventory.md`,
`cost_table.md`.

## What the evidence says, plainly

1. **The fusion thesis itself is supported.** Complementary errors are real
   and material at every level measured: among public systems (C1), and —
   decisively — on our own harness with our own models (C3: every
   pre-named panel cleared the 5pp headroom bar, and a judged replay
   converted headroom into a +10.5pp realized gain over the best single
   model on that slice).
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

For the algorithmic domain, among models runnable with current credentials:
the measured best single is `gpt-5.5` (48.3% pass@1 on the C3 slice), and
`P2 = {gpt-5.5, claude-sonnet-4-6, deepseek-chat}` had the highest measured
oracle (54.2%, headroom +5.1pp). The committed product default panel
(`kimi-k2-thinking` + `qwen3-coder`, per `.fusionkit/fusion.json`) measured
far below it (oracle 35.1%). **The kimi-k2-thinking 5.2% figure is a
confirmed measurement artifact, not model weakness:** verification found
51 of its 58 completions hit the run's 4096 `max_tokens` cap — the thinking
budget consumed the window before code was emitted, so extraction failed.
(GPT-5.5 also truncated on 26/60 but emits code early enough to pass.)
Consequences: P1/P3 headroom is *understated*, the P1 capture measurement is
polluted, and no conclusion about the committed default panel is valid until
the slice is re-run with a materially larger completion budget for thinking
models. That re-run is the cheapest highest-value follow-up (~$5).

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

1. **Re-run the C3 slice with a larger completion budget** (≥ 16k tokens
   for thinking models) — fixes the confirmed kimi truncation artifact and
   yields the first valid read on the committed default panel (~$5).
2. Harden the C3 pilot script into `calibration.py` + the
   `CandidateBank → tier-CAL` adapter (spec §15.3) and run the first real
   150-task two-slice calibration round (spec §15.1) with the P2 panel and
   a proper judge protocol.
3. Start M1 (reduced warehouse) with the three sources that produced
   evidence in this study; port the Phase-0 scripts as the reference
   implementations.
4. Harness work for repo_bugfix calibration (HandoffKit patch-and-test
   path) — the highest-value unlock, since repo tasks are the product's
   core and the public A− data is densest there.
