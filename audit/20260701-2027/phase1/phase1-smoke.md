# Phase 1 — Smoke + spend calibration

- git SHA: `9beaa5e` (includes the LCB dataset OOM fix)
- command: `FUSIONKIT_BENCH_CONFIG=configs/benchmark-panel.gpt-opus.yaml uv run fusionkit public-bench --suite livecodebench --subset 5 --runner-command "uv run python python/fusionkit-evals/adapters/livecodebench_adapter.py"`
- dataset: livecodebench/code_generation_lite release_v6, medium/hard stdin, `>= 2025-01-01`

## Result

- availability: **ran**; 5/5 tasks scored, non-empty `candidate_scores` for both
  panel members (`gpt`, `opus`) → keys, models, adapter, sandbox, pipeline all work.
- fusion_score 0.4 (2/5), measured oracle 0.4, regret 0.0.
- Notable: `arc196_b` fused=PASS while BOTH candidates failed (synthesis can
  produce genuinely better-than-panel outputs on hard tasks).

## Issue found + fixed (commit `9beaa5e`)

First smoke attempt died: the HF `datasets` split generation was OOM-killed
(exit 137) on this 16GB host — some LCB rows carry ~100MB compressed
private-test blobs and the default Arrow writer buffers 1000 rows in RAM.
Fix: `writer_batch_size=8` in `load_problems` (`livecodebench_data.py`), with a
regression test (`test_load_problems_bounds_arrow_writer_batch`).

## Spend calibration

- `cost_total_usd` = $0.5657 for 5 tasks = **$0.113/task solver-candidates only**
  (envelope `cost_scope: solver_candidates_only`; judge+synth not metered
  in-process — measurement gap noted for Phase 2).
- Working estimate with judge+synth (both gpt-5.5, roughly the candidates'
  input plus their outputs re-serialized): **~$0.17/task fused**, well inside the
  $0.30–1.00 planning envelope. Phase budgets stand; no shrinking needed.
- Bank builds (panel only, no judge/synth) ≈ $0.11/task → 120-task bank ≈ $14.
