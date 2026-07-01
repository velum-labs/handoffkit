# Phase 3 — Baseline (frozen bank + diagnosis)

- git SHA: `8b503b5` (bank built after the FusionKernel.producer and empty-bank fixes)
- panel: `configs/benchmark-panel.gpt-opus.yaml` (gpt-5.5 + claude-opus-4-8, judge=gpt, synth=gpt, temp 0.2)
- dataset: LCB code_generation_lite release_v6, medium/hard stdin-only, `>= 2025-01-01`
  → **86 problems is the FULL available window** (60 hard, 26 medium; dates
  2025-01-04 .. 2025-04-06). `--subset 86` = the whole pool.
- bank: `.fusionkit/hillclimb/bank.json` (140MB, gitignored); tracked slim copy
  with candidate contents + pass flags: `bank-slim.json` (tests recoverable
  deterministically from the HF dataset).
- seed 0, `test_fraction 0.34`, `val_fraction 0.4` (stock CLI defaults).

## Diagnosis (full bank, 86 tasks)

| metric | value |
|---|---|
| best single | gpt 41/86 = **0.4767** |
| second | opus 38/86 = 0.4419 |
| oracle ceiling (1 candidate each) | **0.5465** |
| oracle headroom | **+0.0698** (not lopsided) |
| mean failure correlation | 0.6509 |
| decision tasks (candidates disagree) | 15 (8 hard, 7 medium) |
| both-fail | 39; both-pass | 32 |

Per difficulty: hard gpt 21/60, opus 21/60, oracle 25/60; medium gpt 20/26,
opus 17/26, oracle 22/26.

## Baseline compound (LLM-rewrite synthesis, stock prompts)

Stock `fusion-hillclimb --max-iterations 0` locked-test (5 decision tasks):
fused 1.0 vs best single 0.6 (+0.4), McNemar 2-0 — **not significant** (n far
too small). Regret split on locked test: total 0 = judge 0 + synthesis 0;
judge picks named 3/5, decision-task pick accuracy 1.0 (n=3).

## Decision-point analysis

- Headroom exists (+7.0 pts) → NOT the lopsided terminal state. But with only
  15 decision tasks in the 1-sample-per-model bank, no judge/synth prompt tune
  can reach McNemar significance on a locked split (max ~5 discordant test
  tasks). The correlated-failure mass (39/86 both-fail) is where fusion must
  find wins.
- Per `fusion-hillclimb/reference.md` (verified on this exact 86-task window):
  the decisive lever is **execution-guided best-of-N selection** with
  temperature-diverse samples (3/model → pool of 6): pool oracle rises well
  above best-single and public-test filtering captures it
  (verified: fused 0.593 vs best 0.477, McNemar 10-0, leakage-free).
- Audit plan: Phase 4 ablates synthesis policies on the frozen bank (cheap,
  local re-verification vs public/private split); Phase 5 runs the multi-sample
  panel rebuild (Tier 2 config) with a dev/test split LOCKED BEFORE the run;
  Phase 6 evaluates the incumbent once on the locked test.

## Spend

- bank build: 86 tasks × ~$0.113/task (Phase-1 calibration) ≈ **$9.7**
- baseline replay (judge+synth on decision train/val/test + regression eval) ≈ **$1.5**
- Phase 3 total ≈ $11.2; cumulative ≈ **$12.1 of $500**.
