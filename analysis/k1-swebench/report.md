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

1. **The slice has zero selection headroom — the panel was not
   complementary here.** Every qwen3 solve is a subset of terminus's
   solves. The lineage veto (different families) did not produce
   complementary errors on this slice. Per the pre-registered
   interpretation, this slice cannot evidence fusion value regardless of
   capture; a redraw (larger slice and/or a panel with measured
   complementarity on repo-bugfix) is required before further fused spend.
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

## What this means for the program

- The k=1 regime is measurable cheaply and the machinery is sound; the
  binding problem is now **panel complementarity on repo-bugfix**, which
  must be established before capture can mean anything (the C1-style
  public evidence did not transfer to this 10-instance slice).
- The `django-12125` fused-only solve is the single most valuable
  observation: it suggests per-step fusion can beat the trajectory-level
  oracle. Confirming or refuting it at n>1 is the highest-information next
  round: same pipeline, larger slice, and a panel picked for measured
  complementarity.
