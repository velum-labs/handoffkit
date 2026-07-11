# Non-linear ensemble pilot: execution-feedback repair vs pure width (2026-07)

Frozen before the billed run. This is a PILOT (mechanism check + directional
signal), not a confirmation: n is small, the slice is not held out, and no
victory claims will be made from it. Its job is to decide whether the
non-linear repair-loop family earns a Phase A screening lane in
`docs/fusion/ensemble-cost-frontier-campaign-2026-07.md`.

## Question

At a matched call budget of 6 cheap-model calls per task, does a NON-LINEAR
allocation (4 diverse samples + up to 2 execution-feedback repair calls on the
top failing candidates) resolve more LiveCodeBench-style tasks than the LINEAR
allocation (6 diverse samples, execution-guided selection) that our record
already validates?

Secondary mechanism metrics (these decide the verdict as much as the headline):

- repair conversion: of repair calls issued, how many produce a candidate that
  passes all public tests (literature anchor: 2 rounds capture 76-95% of
  achievable self-repair gain; kill threshold <15% conversion);
- public->private gap: do repaired candidates that pass public fail private
  more often than sampled candidates (overfit-to-feedback check);
- early-exit rate: how often 4-wide already contains a public-pass candidate
  (bounds the non-linear arm's cost).

## Systems under test

Panel (cheap, lineage-vetoed, both previously measured on this workload):

- `deepseek/deepseek-v3.1-terminus` via OpenRouter (valid at 32k; 38.3% on the
  c3 60-task slice)
- `qwen/qwen3-coder` via OpenRouter (26.7% on the c3 slice)

| arm | allocation | selection | grading |
|---|---|---|---|
| solo-terminus | 1 call (t=0.2) | — | private tests |
| solo-qwen3 | 1 call (t=0.2) | — | private tests |
| linear-6wide | 3 temps (0.2/0.6/0.9) x 2 models | public-test execution select | private tests |
| nonlinear-4+2 | 2 temps (0.2/0.6) x 2 models, then if no candidate passes all public: top-2 candidates by public score each get one repair call (terminus, execution feedback: failing input/expected/actual/stderr) | public-test execution select over 4 originals + repairs | private tests |
| oracle-6wide | any of the 6 samples passes private | — | reference only |

The linear and non-linear arms share the 0.2/0.6 samples (paired by
construction); the 0.9 samples belong to the linear arm only; repair calls
belong to the non-linear arm only. Cost is attributed per arm accordingly.

## Task set

First 30 problems under the same deterministic predicate as
`fusionkit_evals.livecodebench_data.load_problems` (release_v6, difficulty
medium+hard, contest_date >= 2025-01-01, stdin-only, no starter code, sorted
newest first). Loader note (recorded before the billed run): the HF `datasets`
loader OOMs on this 16GB machine materializing the full release, so the pilot
streams the `test6.jsonl` increment (which contains the newest-first head of
release_v6) with the identical predicate. Question ids are recorded in the
results file. Overlap with prior c3 slices is possible and acceptable for a
pilot.

## Grading and stats

- Sandboxed execution (`fusionkit_evals.sandbox.LocalSandbox`, scrubbed env,
  rlimits), all-or-nothing per test list, `exact` checker, 8s/test.
- Selection uses PUBLIC tests only; grading uses PRIVATE tests (leakage-free,
  same as the validated lcb_select adapter).
- Wilson 95% per arm; exact McNemar (binomial on discordant pairs) for
  nonlinear-4+2 vs linear-6wide and vs best solo.
- Provider failures: the task is dropped from paired comparisons and reported.

## Read-out rules (frozen)

- PROMOTE the repair-loop family to Phase A screening if: nonlinear >= linear
  on paired point estimate AND repair conversion >= 15% AND the
  public->private overfit gap for repaired candidates is <= 15pp worse than
  sampled candidates.
- KILL if repair conversion < 15% or nonlinear loses to linear by > 2 tasks.
- Anything else: record as inconclusive; the family may be re-piloted with a
  different repair prompt or reviewer model but only after the config change
  is written down first.

## Spend cap

$5 hard cap (expected < $1.50: ~100 short calls on $0.2-1.8/M models). Abort
and report if the estimated ledger crosses the cap mid-run.
