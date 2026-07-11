# Round 3 hill-climb: driver-v2 — parity with the best model

Dev slice = the 30-instance 2A' manifest (burned; used for tuning).
Numbers from official harness grading. Baselines reused.

## Result

| config | resolved (dev-30) | Wilson 95% |
|---|---|---|
| solo-terminus | 20/30 (66.7%) | [49%, 81%] |
| **driver-v2** | **19/30 (63.3%)** | [46%, 78%] |
| 2A' fused (synthesize-commit) | 18/30 (60.0%) | [42%, 75%] |
| driver-v1 (prompt + 8-worker OOM) | 14/30 (46.7%) | [30%, 64%] |
| solo-qwen3 | 12/30 (40.0%) | [25%, 58%] |
| oracle(solo) | 21/30 (70.0%) | — |

driver-v2 vs terminus: lost {django-13837, sympy-14248}, gained {django-14500}.
Zero container-death observations (OOM confound eliminated).

## What changed v1 -> v2 (+5 solves)

Two edits, both targeting v1's measured loss modes:

1. **Infra (the dominant fix):** dropped the logging proxy and ran 4 workers
   instead of 8. v1's 10 non-converged instances were Docker container
   deaths under memory pressure (OOM at 8 concurrent SWE-bench containers on
   a 15 GB box) + a proxy connection-error surface — not model behavior. On
   the clean subset v1 was already 14/23 vs terminus 16/23, i.e. −2, not the
   apparent −6.
2. **Prompt:** added continuity ("continue a working approach; switch only on
   observed evidence, not a colleague's preference"), submission-discipline
   ("follow the harness submission procedure; don't emit a text answer in
   its place"), and robust-edit ("verify edits landed; avoid brittle one-shot
   stream edits") clauses to the driver framing.

## Interpretation

- **The user's hypothesis held:** prompting recovered the regression. The
  driver topology, given a prompt that preserves harness discipline and
  path-continuity, reaches **parity with the best single model** (19 vs 20,
  overlapping CIs) and beats every prior fused configuration.
- **Parity, not victory.** 19 vs 20 is within noise. The claim this supports
  is "matches the best member" (and, with the gained django-14500, shows the
  correct-judge-preference case can now land) — not "beats it."
- **Remaining losses are near-misses**, not process failures: both produce
  non-empty patches failing 1-2 tests. Hardest category to move by prompt.
- **Caveat:** this is the dev slice, used across rounds 2C/3. The result may
  be partly dev-adapted; fresh-slice confirmation is required before any
  claim. That run is the sequel to this report.

## Spend

driver-v2: one fused row, ~$6 (OpenRouter export authoritative). v1 rerun
attempts + v2 ≈ $12 this session.
