# Fusion Hill-Climb reference

Detailed metrics, escalation heuristics, and the Tier-2/Tier-3 procedures for the
`fusion-hillclimb` skill.

## SOTA method: execution-guided best-of-N selection (use this first for code)

The decisive lever for making the compound beat every individual model on code is
NOT judge/synthesizer prompt tuning (a judge picks winners on disagreements at ~50%
without test feedback, so wins approx losses and McNemar never reaches significance).
It is execution-guided selection:

1. Sample several candidates per model (temperature diversity) -- test-time compute.
2. Run each candidate on the problem's PUBLIC tests (solver-available).
3. Select the candidate passing the most public tests.
4. Grade the selected candidate on the held-out PRIVATE tests.

Selection uses only public tests and grading uses private tests, so it is
leakage-free. The oracle over the diverse pool exceeds any single model's pass@1,
and public-test filtering reliably captures it -> fused approaches the oracle and
beats the best single model with wins >> losses (significant).

Implementation: `fusionkit_evals.exec_select` (`select_index`, `CandidateSample`),
`fusionkit_evals.livecodebench_data.decode_public_private` (public/private split),
and the runner `packages/fusionkit-evals/adapters/lcb_select_adapter.py`.

Run it:

```bash
FUSIONKIT_BENCH_CONFIG=configs/benchmark-panel.gpt-opus.yaml \
  LCB_SELECT_SAMPLES=3 PYTHONUNBUFFERED=1 \
  uv run fusionkit public-bench --suite livecodebench --subset 86 \
  --runner-command "uv run python packages/fusionkit-evals/adapters/lcb_select_adapter.py" \
  -o runs.jsonl --ledger ledger.jsonl
# then: compare_compound_vs_individual(run) for the per-model table + McNemar
```

Verified result (LiveCodeBench medium/hard, >=2025-01-01, GPT-5.5 + Claude Opus 4.8,
3 samples each): gpt 0.477, opus 0.477, fused 0.593 (+0.116); McNemar 10-0,
chi-square 8.10, significant; leakage-free (avg 2.6 public tests for selection vs 36.4
private for grading). Tip: confirm `decode_public_private` is not falling back
(private must differ from public) before trusting a selection result.

## Metrics (all measured within one run, apples-to-apples)

- pass@1: fraction of scored tasks a model/compound passes (all-or-nothing). Wilson CI via `bench_stats.wilson_interval`.
- best-single: the panel member with the highest pass@1 on the split. Computed from the bank's per-candidate `passed` flags (`best_single_baseline`).
- oracle ceiling: fraction of tasks where at least one candidate passed (`1 - prod(1 - score_i)` analytically; measured directly from the bank).
- oracle headroom: oracle ceiling minus best-single. Near zero => fusion cannot win (correlated failures or one model dominates).
- judge/synthesis regret: oracle minus fused. High regret + high headroom => the judge/synthesizer is the bottleneck (Tier 1/3), not the panel.
- failure correlation: mean pairwise Pearson of candidate failures. Lower => more decorrelated => more headroom.
- target: fused pass@1 minus best-single pass@1 on the LOCKED test, McNemar-significant (`check_target` -> `beats_best_single`).

Engine: `fusionkit_evals.fusion_hillclimb` (`diagnose_bank`, `best_single_baseline`, `run_climb`, `check_target`) and `fusionkit_evals.fusion_compound.compare_compound_vs_individual` for the per-model table.

## Diagnosis -> what to try

| Symptom | Meaning | Action |
| --- | --- | --- |
| headroom > 0, regret high | judge/synth leaves wins on the table | Tier 1 (prompts), then Tier 3 (synthesis logic) |
| headroom ~ 0, lopsided | one model dominates / correlated failures | panel problem: report honestly; consider a different/3rd member; prompts will not help |
| fused < best-single (negative uplift) | synthesizer is actively degrading good candidates | Tier 1 framing fix or Tier 3 best-of-n / select-then-edit |
| high judge parse failures | judge output malformed | Tier 1 judge_system, or Tier 3 parsing |

## Tier 2: config knobs (re-runs the panel; rate-limit by budget)

Edit a copy of the panel config and rebuild the bank (the bank signature changes,
so candidates regenerate). Search one knob at a time; keep a change only if the
locked-test target improves:

- `sampling.temperature` / `top_p` for the panel (diversity vs quality).
- self-fusion sample count / temperatures (more decorrelated candidates).
- judge sampling (the engine already runs the judge at temperature 0).

Re-measure with `fusion-hillclimb` against the new bank path. Each panel rebuild is
the expensive part -- budget accordingly.

## Tier 3: synthesis source changes (gated, autonomous)

Only after Tier 1/2 are exhausted and budget remains. Propose ONE focused change to
the synthesis logic, tied to concrete failure exemplars from the report:

- candidate formatting / ordering in `packages/fusionkit-core/src/fusionkit_core/prompts.py` (`format_trajectories`, `build_fuse_system`).
- judge/synthesis control flow in `packages/fusionkit-core/src/fusionkit_core/judge.py` (e.g. multi-round judging, self-consistency vote, best-of-n select-then-refine).

Procedure for each candidate code change:
1. Make the edit on the climb branch.
2. `uv run pytest -q` (and handoffkit build+test if you touched shared synthesis) MUST stay green; revert if not.
3. Rebuild/replay and run `fusion-hillclimb` to re-measure the locked-test target.
4. Accept (commit) only if the locked-test uplift improves and McNemar stays significant; otherwise `git checkout -- <files>` to revert.
5. Append the outcome (diff summary, scores, decision) to the ledger.

Never weaken or skip tests to make a change pass. A change that needs a test
relaxed is rejected.

## Overfitting control

- The locked test split is evaluated exactly once per climb, never used for selection.
- Prefer a fresh contamination window for the test pool (`LCB_MIN_DATE` newer than the dev/val window) when feasible.
- Regression-guard tasks (all candidates pass) must never regress.

## Cost

- The bank builds the panel once; Tier-1 iterations replay only judge+synth (cheap).
- Tier-2/3 rebuilds re-run the panel (expensive) -- gate behind Tier-1 exhaustion.
- Track spend from provider usage; the public-bench envelope reports `cost_total_usd` (solver candidates), and the gateway path meters judge+synth via `FusionBackend`.
