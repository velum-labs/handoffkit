# C2V preregistration

Written before computing any held-out C2V results.

## Literal preregistered design

This re-test closes the C2 scope caveat by replacing the oracle-only train
selector with the spec's value objective. All data, source universes, base-engine
identity rules, clustering, split machinery, K values, and baseline definition
are inherited from the original C2 preregistration in
`analysis/phase0/c2_preregistration.md`.

Per source: K in `{2, 3}`; split = clustered 50/50 by `cluster_key`, seed=42,
`numpy.default_rng`; clusters are shuffled once and divided at the midpoint.
The one-per-base-engine constraint is unchanged and applies to both the
V-selected panel and the baseline panel.

## Sources and system universes

Use exactly the same registered source universe rules and system lists as
original C2:

- `swe_verified`: all SWE-bench experiment submissions in the verified split
  with submission id dated 2025-01-01 or later; full split attempted by policy;
  unresolved is failure.
- `swe_test`: all SWE-bench experiment submissions in the test split with
  submission id dated 2025-01-01 or later; full split attempted by policy;
  unresolved is failure.
- `terminalbench`: all Terminal-Bench `(agent, model)` systems with at least
  80% distinct task coverage after averaging repeated trials.
- `llmrouterbench_livecodebench`: all LLMRouterBench LiveCodeBench coding
  subset model files with at least 80% task coverage; exclude the OpenRouter
  router baseline because it is not a generator model.
- `llmrouterbench_swebench`: all LLMRouterBench SWE-Bench verified subset model
  files with at least 80% task coverage; exclude the OpenRouter router baseline.
- `llmrouterbench_mbpp`: all LLMRouterBench MBPP coding subset model files with
  at least 80% task coverage; exclude the OpenRouter router baseline.
- `llmrouterbench_humaneval`: all LLMRouterBench HumanEval coding subset model
  files with at least 80% task coverage; exclude the OpenRouter router baseline.

The named system universe and base-engine mapping for each source are the
verbatim lists registered in `analysis/phase0/c2_preregistration.md`; if the
working loader emits a count or mapping that differs from that file, the
analysis must stop or record a deviation before reporting.

## Train-time selector

For each source and K, select the feasible panel on TRAIN by exhaustive argmax:

`V(S) = best_pass(S) + 0.7 * headroom(S)`

where `best_pass(S)` is the best member pass rate on the panel's common TRAIN
tasks, `headroom(S) = oracle(S) - best_pass(S)`, and the 0.7 capture prior is
the conservative pre-calibration prior from spec §11.4. There is no cost or
latency term because the public rows contain no comparable cost data.

Tie-breaking is deterministic: higher `V(S)`, then higher `oracle(S)`, then
higher `best_pass(S)`, then lexicographic display-name order.

## Baseline

The baseline is unchanged from original C2: top-K systems by mean pass rate on
TRAIN, subject to the same one-per-base-engine constraint. Ranking uses each
system's TRAIN tasks covered by that system; tie-breaking is lexicographic by
display name.

## Held-out metrics

The primary held-out metric is:

`Delta_V = V(V-selected panel) - V(baseline panel)`

computed on the HELDOUT common tasks for the union of both panels, with the
same 0.7 capture prior.

Secondary metrics are reported but do not gate:

- `Delta_oracle = oracle(V-selected panel) - oracle(baseline panel)`
- `Delta_best_single = best_pass(V-selected panel) - best_pass(baseline panel)`

If the V-selected and baseline panels are identical, report
`selection agrees with baseline` rather than treating zero as an inconclusive
statistical outcome.

## Statistical test

Use clustered bootstrap over held-out clusters, 1000 resamples, seed=42, and a
two-sided percentile 95% CI for `Delta_V`.

Pass rule: PASS if at least one `(source, K)` has a `Delta_V` CI lower bound
strictly greater than zero.

Fail rule: FAIL if every non-identical `(source, K)` has a `Delta_V` CI upper
bound strictly below zero.

Otherwise: INCONCLUSIVE. Identical-panel cases are excluded from fail counting
and summarized separately as baseline agreement.

## Sanity guards

- No selected panel may contain duplicate base engines.
- The train and held-out cluster sets must be disjoint for every source.
- The held-out metric must use only tasks covered by every system in the
  V-selected and baseline panels.
- No billed API calls are permitted; all rows come from cached public data or
  public HF parquet URLs.

## Capture sensitivity

Repeat TRAIN selection with capture in `{0.5, 0.9}`. Report whether the selected
panel changes relative to the primary 0.7 selection for each source and K. This
is a sensitivity check only and does not gate the pass/fail verdict.

## Deviations

None at preregistration time.
