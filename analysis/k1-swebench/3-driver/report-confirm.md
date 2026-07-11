# Round 3 fresh-slice confirmation: driver-v2 does NOT hold parity

Slice: `confirm_manifest.txt` (seed 45, 30 instances, disjoint from all
prior slices and the smoke instance). Rows run identically (mini-SWE-agent
v2 stock, official harness grading); worker counts memory-capped after the
OOM incidents (solo w=2, fused w=1, earlyoom guard). One instance
(`sympy-13031`) errored in grading for BOTH rows (excluded symmetrically by
the grader; counted unresolved for both).

## Result

| row | resolved | Wilson 95% |
|---|---|---|
| solo-terminus | **19/30 (63.3%)** | [46%, 78%] |
| driver-v2 (frozen from dev) | **16/30 (53.3%)** | [36%, 70%] |

driver-v2 vs terminus: **lost 5** (astropy-14096, django-12325,
django-13810, django-14559, sympy-24562), **gained 2**
(matplotlib-25311, sympy-23950). Net **−3**.

## Interpretation

- **The dev-slice parity (19 vs 20) did not transfer.** On fresh ground the
  tuned driver topology is −3 vs the best single model. The dev result was
  partly slice-adaptation and/or favorable variance — exactly the risk the
  dev/eval split existed to expose, and it did.
- **Composition upside is real but small and outweighed.** Across both
  slices the driver row solves ~2 instances per 30 that the best member
  does not (~7%), while losing ~2-5 member solves (~10-17%). The
  fusion tax exceeds the fusion dividend at every configuration tested.
- **Program verdict, now confirmed on two independent fresh slices:**
  **route, don't fuse** — for this panel (terminus + qwen3), this judge,
  and k=1 fusion in every commit topology tried (synthesize-commit,
  select-adjacent prompts, driver-write via prompt). The best single model
  run solo remains the best system, at 1/3 the latency and ~1/4 the cost.

## What survived the program as durable positives

1. The hill-climb machinery works: 14 -> 19 on dev was real improvement in
   pipeline health (convergence, continuity, submission discipline) — it
   just cannot overcome the quality-gapped panel.
2. Driver-only solves (4 unique across slices) prove deliberation-stage
   composition produces wins selection cannot — the effect the round-1
   django-12125 observation hinted at. It needs a peer-quality panel (per
   Self-MoA/DEI) to become net-positive; panel composition remains the
   untested axis.
3. The full negative result is bounded, pre-registered, and cheap
   (~$35 program total): per-step LLM fusion with a quality-gapped panel
   loses to its best member on SWE-bench Verified under the benchmark's
   own scaffold and grader.

## Spend

Confirmation: solo ~$0.6 + fused ~$5-6 + reruns lost to OOM ~$3.
Program total ≈ $30-38 (OpenRouter export authoritative).
