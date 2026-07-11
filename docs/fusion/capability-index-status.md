# Capability Index — Current Status

**Role of this document:** the single living source of truth for the
program's *current* beliefs, binding scope, and active next steps. It is
updated (in place) at the close of every experiment round or scope
decision; everything else in the program is an immutable record or a design
reference. If this document and any other document disagree, this one wins.

**Last updated:** 2026-07-05 (model-freshness re-think: model-specific
recommendations stale, refresh pipeline proposed —
`strategy-rethink-2026-07.md`; OSS-only rechecks and seed-panel audit
recorded)

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
| Every domain with public data is **peer-shaped for OSS-only fields** (no lopsidedness once closed models are excluded); OSS-only panels show +11 to +23pp oracle headroom, largest on repo bugfix (+17.0pp [+14.3, +20.5]) | Step-1 OSS scan, 6 domains, lineage vetoes recorded | Medium-high (Layer-1 priors; shortlist/veto authority only) | `analysis/oss-scan/report.md` |
| **kimi-k2-thinking is not measurable at practical budgets** on single-shot algorithmic tasks: truncation-invalid at 16k (52/60), 32k (42/60), and 64k (31/60; mean 49k completion tokens) | Step-2 escalation ladder, pre-registered | High — exclude from single-shot panels; agentic/multi-turn measurement still open | `analysis/thinking-32k/report.md` |
| sonnet-class (claude-sonnet-4-6) first valid measurement on this slice: 45.0% [33.1, 57.5] at 32k, 0/60 truncated | Step-2 re-measure | High (one slice) | `analysis/thinking-32k/report.md` |
| Public data cannot rank **OSS-only** panels either (0 product-relevant wins in 10 cases per objective; algorithmic K=3 outright loss); OSS sign transfer 3/3 | OSS-only C2/C2V + sign rechecks, preregistered | High — D2 extended (D12) | `analysis/oss-rechecks/report.md` |
| **All model-specific recommendations are stale**: newest OSS generation (DeepSeek V4, Qwen 3.7, GLM-5.2, Kimi K2.7-code, MiniMax M3, Nemotron 3) absent from every public dump; per-task public data lags the frontier 6–12 months | Live OpenRouter catalog vs evidence-base eras (D13) | High — structural | `strategy-rethink-2026-07.md` |
| Truncation-invalidity generalizes across the thinking-model class: r1 15/50 and qwen3t 19/57 truncated at 32k (both INVALID); terminus VALID at 32k (0/60, $0.14/60 tasks — bridge candidate) | Seed-panel audit, preregistered; 64k escalation held under D13 | High (one slice) | `analysis/seed-audit-32k/report.md` |

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
- **OSS-first (D8, 2026-07-05):** panels are built from OSS models; closed
  frontier models (gpt-5.5, Claude, Gemini) serve as routing baselines and
  price anchors, not panel members. Product claims are Pareto claims
  (score *and* cost-per-solve), not saturation claims.

## Active next steps (priority order)

Maintained in detail in `oss-ensemble-launch-plan.md` (adopted
2026-07-05); summary:

1. ~~**Step 1 — OSS peer-field scan**~~ **DONE 2026-07-05**
   (`analysis/oss-scan/`): all covered domains peer-shaped for OSS;
   recommended pilot = repo bugfix model-level, panel seed
   deepseek-r1-0528 + deepseek-v3.1-terminus + qwen3-235b-a22b-thinking-2507
   (kimi-k2-0905 alternate), frontier anchor claude-opus-4.1.
2. ~~**Step 2 — Thinking-model re-measure at ≥32k**~~ **DONE 2026-07-05**
   (`analysis/thinking-32k/`, $16.51): sonnet valid at 45.0%;
   kimi-k2-thinking ruled **not measurable at practical budgets** on
   single-shot tasks (still 31/60 truncated at 64k) — excluded from
   single-shot panels.
3. **[REVISION PENDING — D13]** Steps 3+ are paused by the model-freshness
   re-think (`strategy-rethink-2026-07.md`): the Step-1 seed panel is
   generations behind the current OSS frontier. Proposed replacement
   funnel (awaiting founder approval on shortlist, budget policy, and
   spend authority):
   - **Step 0′** — refresh candidate universe from provider catalog ($0);
   - **Step 1′** — calibrated sweep of the fresh shortlist on the 60-task
     manifest with truncation audits (~$25–50) → our own per-task matrix;
   - **Step 2′** — split-validated panel selection + capture pilot
     (~$10–20), superseding capture-pilot-1 (run abandoned, protocol kept);
   - **Step 3′** — repo-bugfix flagship after Step 4, with a fresh sweep.
4. **Step 4 — Repo-bugfix harness unlock** (engineering): unchanged, still
   the launch bottleneck; runs in parallel with the above.
5. **Step 5 — Full benchmark confirmation** (~$100–500): survivor only,
   frozen config, official harness, **dated evidence card** with freshness
   stamp (refresh cadence ~3–4 months per D13).
6. **Step 6 — Launch**: predefined ensemble in the CLI + public evidence
   card.

The previously listed contamination check on the C3 slice is demoted (not
cancelled): with gpt-5.5 excluded from OSS-first panels, its dominance no
longer drives panel decisions; the check rides along with Step 5 hygiene.

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
| `oss-ensemble-launch-plan.md` | Execution plan for the launch funnel | Living, revised at gate decisions |
| `capability-index-program.md` | History + decision log | **Append-only** |
| `capability-index-spec.md` | Design reference | Living, design changes only, with changelog |
| `phase0-validation-report.md` | Phase-0 record | **Closed** 2026-07-04 |
| `coding-capability-index-report.md` | Stage-1 analysis record | Closed |
| `analysis/phase0/` | Phase-0 experiment artifacts | Closed (cache regenerable) |

## Changelog

- **2026-07-05 (latest)** — Model-freshness re-think (D13): model-specific
  recommendations declared stale; refresh-pipeline funnel proposed, Steps
  3+ paused pending approval. OSS-only C2/C2V + sign rechecks close (D12:
  D2 extended to OSS universes). Seed-panel truncation audit closes at the
  32k rung (D14: terminus valid; r1/qwen3t invalid; escalation held).
  Round spend $5.00 (audit) + $0 (rechecks).
- **2026-07-05 (later)** — Launch-plan Steps 1–2 executed and closed:
  OSS scan beliefs added (all domains peer-shaped, repo-bugfix pilot
  recommended); kimi-k2-thinking ruled not measurable at practical
  budgets on single-shot slices (16k/32k/64k ladder); first valid
  sonnet measurement recorded. Round spend $16.51.
- **2026-07-05** — OSS-first scope adopted (D8); next steps replaced by
  the staged launch funnel in `oss-ensemble-launch-plan.md`; C3
  contamination check demoted to Step-5 hygiene.
- **2026-07-04** — Document created at Phase-0 close. Initial beliefs,
  scope (reduced build, ranking cancelled), and next steps recorded from
  C0–C3 + C2V + C3-R16K outcomes.
