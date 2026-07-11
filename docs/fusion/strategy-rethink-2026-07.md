# Strategy rethink — incorporating the newest OSS generation (2026-07-05)

**Status:** decision document, written after the 2026-07-05 rethink discussion.
**Reader:** anyone deciding what the ensemble program does next.
**Supersedes:** the model-specific recommendations of `analysis/oss-scan/report.md`
(D10 seed panel); does **not** supersede any structural finding or decision
(D1–D9, D11 for the audited model).

---

## 1. Executive summary

The program's evidence base ranks OSS models that are now two to three
generations old. The newest OSS generation (DeepSeek V4, Qwen 3.7, GLM-5.2,
Kimi K2.7-code, MiniMax M3, Nemotron 3 — all listed on OpenRouter between
2026-03 and 2026-06) appears in **none** of our data, because public per-task
benchmark dumps lag the model frontier by 6–12 months.

This breaks every **model-specific** conclusion (which panel to seed, which
model to exclude) but **no structural** conclusion. In particular, the
program's central negative result — public data cannot rank panels (C2, C2V,
and the 2026-07-05 OSS-only recheck) — turns out to be future-proofing: for
the newest models, per-task public data does not merely fail to rank, it does
not exist. Calibration-first was already the only viable path; model turnover
just makes that unavoidable.

The revised plan replaces "mine public dumps, then calibrate" with a
**repeatable refresh pipeline**: enumerate current models from the provider
catalog ($0) → shortlist by aggregates/price/lineage ($0) → measure our own
per-task matrix with truncation audits (~$25–50) → select panels on a train
split, confirm on held-out tasks → capture pilot (~$10–20) → full benchmark
($100–500, survivors only) → **dated** evidence card. Total to
launch-validating numbers: roughly **$70–120** in API spend plus the Step 4
repo-grading harness (engineering, $0 API).

## 2. What triggered this

A live OpenRouter catalog query (2026-07-05) against the models in our
evidence base:

| Family | In our data (era) | Current generation (listed) | Current $/M in/out |
|---|---|---|---|
| DeepSeek | r1-0528 (2025-05), v3.1-terminus (2025-09) | **v4-pro / v4-flash** (2026-04) | 0.43/0.87 · **0.09/0.18** |
| Qwen | qwen3-235b-a22b-thinking-2507 (2025-07) | **3.7-plus / 3.7-max** (2026-05/06) | 0.32/1.28 · 1.25/3.75 |
| Z.ai | glm-4.6 / glm-5 (2025) | **GLM-5.2** (2026-06) | 0.57/1.80 |
| Moonshot | kimi-k2-0905 / k2-thinking (2025) | **Kimi K2.7-code** (2026-06) | 0.74/3.50 |
| MiniMax | m2.x (2025–26) | **M3** (2026-05) | 0.30/1.20 |
| NVIDIA | (absent) | **Nemotron-3-ultra/super** (2026-03/06) | 0.08–0.50/0.45–2.20 |

Notes: (a) the price floor collapsed — deepseek-v4-flash is 30–80x cheaper per
token than claude-sonnet-class models, which materially strengthens the Pareto
positioning; (b) most new flagships carry 1M-token context; (c) coding-
specialized OSS variants now exist (Kimi K2.7-code).

None of these models appears in LLMRouterBench, the SWE-bench experiments
repo, or (mostly) Terminal-Bench. Terminal-Bench refreshes fastest and covers
part of the *previous* generation (glm-5, kimi-k2.5, minimax-m2.5); nothing
covers the current one.

## 3. What is stale vs. what survives

### Stale (model-specific data products)

| Item | Why stale | Replacement |
|---|---|---|
| D10 seed panel (deepseek-r1-0528 + v3.1-terminus + qwen3-235b-thinking) | Members are 2–3 generations old | Fresh sweep (Step 1′) |
| OSS scan rankings/headroom numbers per domain | Mid-2025 model universe | Fresh sweep per domain |
| D11 kimi-k2-thinking exclusion | Applies to that model only, not K2.7-code | Re-audit new model |
| capture-pilot-1 panel composition | Old-generation members ($0.51 sunk) | New-gen panel after sweep; protocol reused |

### Durable (structural findings and methods)

| Finding / method | Why it survives |
|---|---|
| C1: peers make complementary errors (+8–12pp headroom) | Field property, observed across sources and generations; new OSS convergence likely strengthens it |
| C2/C2V/OSS-recheck: public data cannot rank panels | Strengthened — newest models have no per-task public data at all |
| Truncation discipline (>10% truncated ⇒ refuse the number) | Class-level lesson about thinking models; applies to every new reasoning model |
| Sign transfer (10/10 mixed; 3/3 OSS-only) | Public failure-correlation signs remain valid for lineage vetoes where data exists |
| Peer/lopsided gate, lineage veto, prereg + ledger discipline | Methods, not data |
| Domain gates (peer shape × headroom × demand × gradeability) | Structural; domain *ranking* likely stable, numbers need refresh |

## 4. The founder's five questions — current answers

**Q1 Which domains?** Domains passing four gates: peer-shaped OSS field,
large headroom, real demand, gradeable in our harness. Ranking (directional,
from stale data; shape likely stable): **repo bugfix** flagship (+17pp
headroom, top demand), terminal-agentic second, algorithmic as mechanics
testbed only (gpt-5.5 dominates the slice by +35pp → price claim only),
MBPP/HumanEval never (saturated toy).

**Q2 Can we compare ensembles vs alternatives?** Yes — deterministic 60-task
harness, preregistration, spend ledgers, truncation audits, capture-pilot
protocol with non-member judge and train/hold-out splits; $10–50 per round.
Gap: only algorithmic is gradeable today; Step 4 unlocks repo bugfix and
blocks every flagship number.

**Q3 Saturate benchmarks?** No — settled. The claim is **Pareto**: named
domain, pass rate + $/solve vs the cheapest frontier model that beats us,
on rolling benchmarks, with a truncation audit and a **freshness stamp**.
The refresh pipeline (this document, §5) is what keeps the claim alive
across model generations.

**Q4 Can ensembles beat frontier?** Domain-conditional. Lopsided slices: no
score claim, price only. Peer domains: oracle headroom means plausibly yes
(stale-data example: repo-bugfix OSS panel oracle 45.6% vs claude-opus-4.1
anchor 41.6%), and the unreplicated 150%-capture synthesis replay suggests
fused output can exceed even the selection ceiling. Focus one flagship
domain first; "SOTA by ensemble" is a sequence of narrow dated wins.

**Q5 What is public data good for?** Shortlisting (aggregates), vetoing
(failure-correlation signs, lineage), domain triage (field shape). Never
final panel ranking — settled three times (C2 0/14; C2V 0/14; OSS-only
recheck: upheld on all product-relevant domains, single stray MBPP pass).
For the newest models the question is moot: per-task public data does not
exist; ranking is calibration-only.

## 5. The revised plan (refresh pipeline)

| Stage | Cost | What it does | Kill rule |
|---|---|---|---|
| **0′ Refresh universe** | $0 | Enumerate OSS models from OpenRouter catalog; shortlist 8–12 by vendor aggregates, price band, context, provider stability, lineage veto (one per family); keep 1–2 previous-gen bridges (e.g. v3.1-terminus) to link generations | — |
| **1′ Calibration sweep** | $25–50 | All shortlisted models single-shot on the 60-task manifest, 32k budget, truncation audit built in → **our own per-task matrix** for the current generation → C1 math (headroom, phi, peer shape) on Layer-CAL data | No panel ≥ ~8pp headroom → wrong domain or models |
| **2′ Select + capture pilot** | $10–20 | Select panels on a train split (C2 lesson applies to our data too), confirm headroom held-out or on fresh LCB rolling-window tasks; capture pilot with non-member judge | Capture ≪ 50% → fusion R&D becomes priority |
| **3′ Flagship domain** | Step 4 eng + $30–50 | Repeat 1′+2′ on repo bugfix once grading is wired | Two failed panels → domain or approach wrong |
| **4′ Full benchmark → evidence card** | $100–500 | Survivors only; frozen config; dated card: pass rate, $/solve vs anchor, truncation audit, model list, date | Fused < best member, or loses $/solve → no launch claim |

**Metrics in evaluation order** (each only matters if the previous passed):
validity (truncation) → capture rate → fused vs best member → $/solve vs
frontier anchor.

**Cadence:** OSS generations turn over every ~3–4 months; the sweep is the
~$30 refresh that re-issues evidence cards per generation. The pipeline, not
any single number, is the durable asset.

## 6. New evidence recorded this round (2026-07-05)

### OSS-only rechecks ($0, preregistered — `analysis/oss-rechecks/`)

- **C2/C2V on OSS-only universes:** conclusion upheld on every
  product-relevant domain. Algorithmic K=3: outright loss (−1.3pp,
  CI [−2.5, −0.2]). One stray pass on MBPP/HumanEval K=3 (+2.6pp) — 1 win in
  10 cases per objective, least relevant domain, insufficient against a
  twice-settled negative. D2 unchanged.
- **Reassuring detail:** on repo bugfix model-level K=2, complementarity
  selection and top-K-by-average pick the *same* panel — seed pairs are
  robust to selection objective.
- **Sign transfer OSS-only: 3/3 agreement** (deepseek/kimi, deepseek/qwen3,
  kimi/qwen3) — the veto/shortlist use of public phi holds on the OSS slice.

### D10 seed-panel truncation audit (`analysis/seed-audit-32k/`)

Preregistered before the rethink; kept running because the protocol and the
thinking-model truncation data transfer to the new generation as a
class-level lesson, and terminus may carry forward as a bridge model.
Completed 2026-07-05, $5.00 of the $20 cap, 60/60 tasks per model:

| Model | pass@1 @32k (context) | truncated | verdict |
|---|---:|---:|---|
| deepseek-v3.1-terminus | 23/60 (38.3%) | **0/60** | **VALID at 32k** |
| deepseek-r1-0528 | 24/60 (40.0%) | 15/50 | invalid at 32k; 64k escalation **held** |
| qwen3-235b-a22b-thinking-2507 | 30/60 (50.0%) | 19/57 | invalid at 32k; 64k escalation **held** |

Takeaways: (1) the truncation lesson generalizes — **both** thinking-style
seed members are unmeasurable at 32k, exactly the failure mode that
invalidated kimi-k2-thinking (D11); any sweep that includes reasoning models
must budget 64k or audit per-model. (2) terminus is a clean, very cheap
($0.14 for 60 tasks) valid measurement — a good bridge model for the fresh
sweep. (3) qwen3t's 50% context pass rate (vs gpt-5.5's 80%) is the best OSS
number we have measured on this slice, but it is truncation-invalid; treat as
directional only. (4) r1 had 10 mid-stream provider JSON failures on
OpenRouter — harness robustness backlog item before any larger sweep.

## 7. In-flight work — disposition

| Item | Disposition |
|---|---|
| seed-audit-32k | Finish (protocol validation + old-gen data point); 64k escalation **held** pending plan approval |
| capture-pilot-1 (29/60 rows, $0.51) | Abandon the run; keep the preregistered protocol for Step 2′ |
| oss-rechecks | Complete — generation-independent, results above |
| Step 4 repo harness | Unchanged — still the launch bottleneck, still recommended in parallel |

## 8. Decisions needed before execution

1. **Shortlist composition** (draft: deepseek-v4-pro or -flash, qwen3.7-plus,
   glm-5.2, kimi-k2.7-code, minimax-m3, nemotron-3-super, + terminus bridge).
2. **Sweep budget policy** — 32k completion budget for all models (safe for
   thinking models, ~2x cost) vs tiered budgets.
3. **Spend authority** — ~$40–70 for stages 0′–2′ now, or gate each stage.
4. **Launch shape** (unchanged from the briefing): wait for fused-ensemble
   evidence, or ship routing + DIY ensembles first with fusion as v1.1.

## 9. Artifact index

| Artifact | Path |
|---|---|
| This document | `docs/fusion/strategy-rethink-2026-07.md` |
| OSS-only rechecks (prereg, report, CSVs) | `analysis/oss-rechecks/` |
| Seed-panel audit (prereg, outcomes, ledger, report) | `analysis/seed-audit-32k/` |
| Prior scan (now superseded for model picks) | `analysis/oss-scan/report.md` |
| Launch plan being revised | `docs/fusion/oss-ensemble-launch-plan.md` |
| Living beliefs | `docs/fusion/capability-index-status.md` |
| Program history / decisions D1–D11 | `docs/fusion/capability-index-program.md` |
| Meeting briefing (visual) | `analysis/briefing-2026-07-05/findings_briefing.html` |
