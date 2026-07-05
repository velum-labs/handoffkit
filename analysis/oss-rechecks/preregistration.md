# OSS-only rechecks preregistration

Frozen before running either recheck. No billed API calls are made in this
round; both rechecks are pure reanalysis of committed data and cached public
snapshots.

## Motivation

Decision D8 makes product panels OSS-first, but the C2/C2V "public data cannot
rank panels" verdicts and the C3 failure-dependence sign-transfer result were
computed on mixed universes (closed + OSS systems). These rechecks test whether
those conclusions hold on the OSS-only universes where they are actually
applied.

## Recheck 1 — OSS-only C2 + C2V selection value

- Universes: for each OSS-scan domain, the systems with `is_oss == True` in the
  committed `analysis/oss-scan/oss_classification.csv`, applied to the same
  source matrices the scan used (`build_domains()` in
  `analysis/oss-scan/scripts/oss_scan.py`).
- Domains with fewer than 3 OSS systems are reported as skipped
  (`repo_bugfix_system_test` has 0 OSS systems).
- Protocol is identical to the original C2 (`analysis/phase0/c2_preregistration.md`)
  and C2V (`analysis/phase0/c2v_preregistration.md`) analyses, reusing their
  committed functions unmodified:
  - K in {2, 3};
  - clustered 50/50 split by `cluster_key`, seed 42, `numpy.default_rng`;
  - C2 objective on TRAIN: exhaustive `oracle(S)` subject to one-per-base-engine;
  - C2V objective on TRAIN: `V(S) = best_single + 0.7 * (oracle - best_single)`
    with capture sensitivity at 0.5 and 0.9;
  - baseline: top-K by mean pass rate on TRAIN, one-per-base-engine;
  - held-out metric: `Delta_oracle` (C2) / `Delta_V` (C2V) vs the baseline;
  - test: clustered bootstrap over held-out clusters, 1000 resamples, 95% CI;
  - pass rule: some CI lower bound > 0; fail: every non-identical CI upper
    bound < 0; otherwise inconclusive.
- Outputs: `c2_oss_results.csv`, `c2v_oss_results.csv`, and a section in
  `report.md`, all recomputed from the matrices, not stdout.

## Recheck 2 — OSS-only C3 sign transfer

- Data: committed `analysis/phase0/c3_outcomes.csv` (calibrated) and the cached
  LLMRouterBench LiveCodeBench per-record files used by the original C3 report
  (public), read through the committed functions in
  `analysis/phase0/scripts/c3_transfer_pilot.py`.
- Filter: pairs among the OSS calibrated endpoints only —
  `deepseek` (deepseek-chat), `kimi` (kimi-k2-thinking), `qwen3` (qwen3-coder);
  3 pairs.
- Metric: sign agreement between public phi and calibrated phi, the same
  `phi_from_pairs`/`sign` functions and the same succeeded-rows-only rule as
  the original report.
- Pass rule: all 3 OSS pairs agree in sign; otherwise report the disagreeing
  pairs. This is a strict subset of the original 10/10 result, so the expected
  outcome is 3/3; the recheck exists to make the OSS-only slice explicit and
  citable.
- Output: `c3_sign_oss.csv` and a section in `report.md`.

## Deviations

None at preregistration time.
