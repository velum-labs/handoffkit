# Phase 2 — Instrumentation before spend (commit `3577ffb`, ~$0)

Measurement gaps closed, each with unit tests against synthetic fixtures (no
billed calls):

## Regret split (rubric 3.2)

- `fusionkit_core/judge.py`: the judge's own pick (`analysis.best_trajectory`)
  is now preserved into the fused trajectory's synthesis metrics as
  `judge_best_trajectory` (distinct from `selected_trajectory_id`, which is a
  verbatim content match).
- `fusionkit_evals/fusion_hillclimb.py`: new `RegretSplit` + `regret_split()` —
  additive decomposition `oracle − fused = judge_regret + synthesis_regret`
  via the pick-verbatim counterfactual (pick policy falls back to the fused
  output when the judge names no pick, matching `synthesis_select_best`
  runtime behavior). Wired into the `fusion-hillclimb` CLI response
  (`test_regret_split`) and markdown report for both LCB and polyglot.
- `fusionkit_evals/fusion_bench.py`: per-task `judge_pick_model_id`,
  `judge_pick_success`, `judge_pick_regret`, `synthesis_rewrite_regret`
  + aggregates.

## Judge selection accuracy (rubric 3.1)

- `prompt_tuning.replay_task` records `judge_pick_model` / `judge_pick_passed`
  per task (bank replay path); `regret_split` reports decision-task pick
  accuracy and the strict exactly-one-correct variant.
- `fusion_bench` aggregate `judge_selection_accuracy` over decision rows.

## Per-stage cost/latency (rubric 7.1–7.2)

- `judge.py` / `fusion.py`: `FuseResult.stage_metrics` carries judge +
  synthesis usage/latency (with `skipped: true` when select-best returns a
  candidate verbatim); folded into `FusionResult.metrics["stage_metrics"]`.
- LCB adapter: per-task `stages` breakdown (`cost_panel/judge/synth_usd`,
  `latency_panel/judge/synth_s`), `judge_pick_model` per row, and row
  `cost_usd` now covers the FULL fusion pipeline (`cost_scope:
  full_fusion_pipeline`, was `solver_candidates_only`). `SCORING_VERSION`
  bumped to 3 (busts the 5 cached smoke rows).

## Tests

- `tests/test_judge.py`: stage metrics recorded (rewrite + select-best paths),
  judge pick preserved in synthesis metrics.
- `tests/test_fusion_hillclimb.py`: additive regret split, attribution to judge
  vs synthesis components, no-pick fallback, empty case.
- `tests/test_fusion_bench.py`: judge-wrong-pick, rewrite-ruined-it, and
  no-pick regret scenarios + aggregate accuracy.
- `tests/test_prompt_tuning.py`: `replay_task` maps `best_trajectory` back to
  the bank candidate.

Gates: `uv run pytest tests -q` green (306 tests), `ruff` clean, `pyright`
0 errors.
