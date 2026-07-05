# Capability Index — Current Status

**Role of this document:** the single living source of truth for the
program's *current* beliefs, binding scope, and active next steps. It is
updated (in place) at the close of every experiment round or scope
decision; everything else in the program is an immutable record or a design
reference. If this document and any other document disagree, this one wins.

**Last updated:** 2026-07-04 (after Phase 0 close: C0–C3, C2V, C3-R16K)

---

## Update protocol (how future rounds land)

When an experiment round or build milestone completes:

1. Its artifacts live in a new `analysis/<round-name>/` directory
   (pre-registration written before results, report frozen at close —
   records are never edited after closing; corrections are new records).
2. **This document** is updated: beliefs table, binding scope, next steps,
   and a changelog line.
3. A history entry and any decisions are **appended** to
   `capability-index-program.md` (append-only; never rewrite old entries).
4. `capability-index-spec.md` is edited only for *design* changes, with a
   changelog line; scope authority stays here, not in spec addenda.

## Current beliefs (evidence-backed)

| Belief | Evidence | Confidence | Record |
|---|---|---|---|
| Strong peer systems make complementary errors (+8–12pp panel headroom) | C1, three sources, CIs, floors met | High | `analysis/phase0/c1_c2_report.md` |
| Public per-task data cannot rank panels (neither oracle- nor V-selection beats top-K-by-average out of sample) | C2 + C2V, pre-registered, 7 matrices | High — **settled** | `c1_c2_report.md`, `c2v_report.md` |
| Failure-dependence *signs* transfer from public data to our harness | C3, 10/10 pairs | Medium-high (one domain) | `c3_transfer_report.md` |
| Single-shot algorithmic (recent LCB): lopsided — gpt-5.5 80% [68, 88], +38pp over next; panel headroom +1.7pp [0, +5] → **don't fuse there** | C3-R16K | Medium — pre-cutoff task window; contamination check pending | `c3r16k_report.md` |
| Synthesis-style fusion can exceed the candidate-selection oracle | C3 judged replay (38.6% fused vs 35.1% oracle) | Directional — needs a clean protocol | `c3_transfer_report.md` |
| kimi-k2-thinking (and partially sonnet) are not validly measurable below ~32k completion budgets | C3-R16K truncation counts (52/60 at 16k) | High | `c3r16k_report.md` |

## Binding scope (what we are building)

Authority for these decisions: Phase-0 outcomes (see
`phase0-validation-report.md` for the reasoning; this list is the current
binding version).

- **Build:** reduced warehouse (schemas, connectors for SWE-bench
  experiments / LLMRouterBench / Terminal-Bench, identity resolution,
  quality report); shortlist-and-veto analytics; cards as evidence reports;
  the calibration loop as the primary selection engine.
- **Cancelled:** public-prior panel *ranking* (any objective);
  aggregate-proxy diversity selection; S1 (LiveCodeBench artifact hunt) and
  S9 (preference data) ingestion; learned router.
- **New hard requirement:** calibration runs record per-row completion
  truncation; pass-rate claims are refused for any model with >~10%
  truncation; thinking models get ≥16k (often ≥32k) budgets.
- **Routing rule already evidence-backed:** lopsided slice → single model.

## Active next steps (priority order)

1. Post-cutoff contamination check on the C3 slice (~$10) — confirms or
   weakens the "don't fuse on algorithmic" answer.
2. Thinking-model re-measure at ≥32k (kimi, sonnet; ~$8) — first valid
   member-level verdict on the committed default panel.
3. Synthesis-focused calibration round (clean judge protocol, synthesis vs
   selection ablation, on a slice with headroom) — chases the
   oracle-exceeding result.
4. Repo-bugfix harness unlock (HandoffKit patch-and-test path) — where C1
   says peer-panel headroom lives.
5. M1 reduced warehouse (port Phase-0 scripts as reference
   implementations).
6. Rule router v0 once 1–4 fill the per-domain table.

## Open questions

- Is gpt-5.5's dominance on the C3 slice contamination-inflated? (→ step 1)
- Does the synthesis-beats-oracle result replicate under an anonymized,
  order-randomized protocol with no verbatim-answer leakage? (→ step 3)
- Does peer-panel headroom on agentic/repo tasks survive same-harness
  calibration the way algorithmic headroom did not? (→ steps 3–4)

## Document map

| Document | Role | Mutability |
|---|---|---|
| `capability-index-status.md` (this) | Current beliefs, scope, next steps | **Living** — updated every round |
| `capability-index-program.md` | History + decision log | **Append-only** |
| `capability-index-spec.md` | Design reference | Living, design changes only, with changelog |
| `phase0-validation-report.md` | Phase-0 record | **Closed** 2026-07-04 |
| `coding-capability-index-report.md` | Stage-1 analysis record | Closed |
| `analysis/phase0/` | Phase-0 experiment artifacts | Closed (cache regenerable) |

## Changelog

- **2026-07-04** — Document created at Phase-0 close. Initial beliefs,
  scope (reduced build, ranking cancelled), and next steps recorded from
  C0–C3 + C2V + C3-R16K outcomes.
