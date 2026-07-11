# k=1 SWE-bench arm — round report (2026-07-07)

Preregistration: `preregistration.md` (frozen 2026-07-07, two recorded
deviations, three pre-run amendments none). All numbers recomputed from the
official SWE-bench harness report JSONs by `scripts/analyze_swebench.py`,
never from stdout.

## Verification

- All three rows submitted 10/10 manifest instances; every fused and
  terminus patch non-empty; one empty qwen3 patch (counted as its own
  failure, not excluded).
- Grading: official harness (`swebench.harness.run_evaluation`), local
  Docker, 0 errors, 0 unstopped containers per row.
- Runner git SHA and mini version recorded under `runs/`.

## Results

| row | resolved | rate | Wilson 95% |
|---|---|---|---|
| solo-terminus (deepseek-v3.1-terminus) | 6/10 | 60% | [31.3%, 83.2%] |
| solo-qwen3 (qwen3-coder) | 4/10 | 40% | [16.8%, 68.7%] |
| **fused (N=2, k=1, step prompts)** | **5/10** | **50%** | [23.7%, 76.3%] |
| oracle(solo) | 6/10 | 60% | [31.3%, 83.2%] |

Headroom (oracle − best solo): **0 instances.** Fused − best solo: **−1.**

Per-instance grid: see `scripts/analyze_swebench.py` output; key rows:

- `django__django-12125`: **fused resolved; NEITHER member resolved solo.**
- `astropy__astropy-14508`, `pylint-dev__pylint-7080`: terminus resolved
  solo; fused did not.

## Findings

1. **The slice has zero *selection* headroom** — every qwen3 solve is a
   subset of terminus's solves on these 10 instances.
   **[AMENDED 2026-07-07]** The original conclusion drawn here ("this
   slice cannot evidence fusion value; redraw required") overclaimed, two
   ways: (a) the solo-selection oracle is the ceiling for
   *whole-trajectory selection*, not for k=1 — step fusion composes paths
   neither member walks alone, and finding 2 (`django-12125`, fused-only
   solve) exceeds that oracle on this very slice; it is a diagnostic
   lower frame only. (b) At n=10 (4 vs 6 solves) the subset relation is
   compatible with noise and licenses no claim about the panel. The
   direct measure of composition value is the **fused-only-solve rate**,
   to be estimated at larger n. Panel complementarity remains untested,
   not falsified.
2. **Step fusion created a solve that selection could not have produced.**
   `django__django-12125` was resolved by the fused run only — with zero
   solo headroom, any pure per-trajectory selector is capped at the best
   member, so this is step-level path construction (different committed
   step sequence), echoing the Phase-0 "synthesis exceeds the selection
   oracle" lead in the k=1 regime. n=1; directional only.
3. **Fusion also lost two best-member solves.** The judge committed step
   sequences that missed two instances terminus solved alone. Judge
   selection losses are the next diagnostic target (pre-registered path:
   OTLP-traced rerun of the losing instances under a new preregistration).
4. **Latency is structurally ~3x a solo agent per step.** Each fused step
   is members-in-parallel, then judge, then synthesizer (~5–20s/step
   observed over 28–55 steps/instance). This is a production-relevant
   property of k=1 fusion, not an implementation bug.
5. **Feasibility confirmed.** The product's native step-mode path ran 10
   real SWE-bench Verified instances end-to-end behind the benchmark's
   endorsed scaffold with zero scaffold modifications, zero harness
   errors, and 10/10 submissions.

## Spend

- Solo rows (mini/litellm, pinned registry): $0.14 (terminus) + $0.39
  (qwen3).
- Fused row: mini's display is inert for `fusionkit/panel` (recorded
  asymmetry); estimated ~$1–2 from call volume (~3 calls/step, ~430 steps
  total, member-call cost from the solo rows). Precise attribution:
  OpenRouter activity export.
- Total round ≈ $2–3 of the $25 cap; the $12 solo abort checkpoint was
  never approached.

## Deviations

The two recorded in `preregistration.md` (litellm price registry; worker
count 2→4 mid-fused-row, wall-clock only). No others.

## Program status (updated 2026-07-07, after rounds 2B/2C/2A')

This report was round 1. The full arc is: `autopsy/report.md` (2B: judge
abstention 41-58%, synthesizer verbatim compliance ~20-30%, both
prompt-resistant), `2c/report.md` (2C: strict-commit prompt wins weakly;
judge-discipline prompt backfires), `2a/report.md` (2A': frozen winner on
a fresh n=30 slice — **fused 18/30 vs best solo 20/30, fused-only solves
0/9, verdict: route-don't-fuse for this configuration**).

## What this means for the program

- The k=1 regime is measurable cheaply and the machinery is sound.
- **[AMENDED 2026-07-07]** The binding hypothesis is **aggregation
  quality, not panel composition**: both losses are judge/verification
  failures (see `failure_analysis.md`) that were winnable with this exact
  panel, and the fused-only solve shows composition value exists even at
  zero selection headroom. Next rounds: traced judge autopsy on the dev
  instances, then judge/synthesis variants on the fixed panel + dev
  slice, then confirmation of a frozen winner on a fresh disjoint slice.
  This 10-instance slice is hereafter a **dev set** (its failures have
  been analyzed; it can no longer confirm anything).
