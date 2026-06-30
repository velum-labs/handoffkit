# FusionKit Benchmark Manifests

This directory contains benchmark task manifests that are meant to be consumed by
`fusion-bench`. A manifest is a directory of `benchmark-task-record.v1` JSON files.
The records are the source of truth; reports must be computed from records rather
than raw transcripts or ad hoc logs.

## Dirty Dozen

`dirty-dozen/` is the MF-50 seed manifest. It contains 12 synthetic, secret-free
tasks across the four model-fusion repositories:

- `fusionkit`
- `handoffkit`
- `cursorkit`
- `mlx-lm`

Each task includes source repo, source SHA, prompt hash, setup hash, expected
evidence, scorer, holdout flag, contamination notes, and allowed tools. Prompts
describe the work to evaluate; they do not include answers or patch solutions.

## Clean-Checkout Setup

To reproduce setup for a task:

1. Check out the repository named by `source_repo`.
2. Check out the commit named by `source_sha` when it points at a real commit. The
   current seed records use synthetic SHAs until cross-repo benchmark pins are cut.
3. Recreate the task environment from `setup_hash` and the manifest README for the
   owning repo.
4. Run candidates with only the tools listed in `allowed_tools`.
5. Persist artifacts and records needed by `expected_evidence`.

The manifest intentionally does not run agents or fetch other repositories in this
ticket.

## Scoring Policy

`model_fusion` records use lightweight text scorers where current FusionKit can run
them as prompt-only tasks. `harness_coding` records use `record_join` because their
real score depends on future harness artifacts, test output, worktree state, or
receipts.

When no HandoffKit executor is configured, `FusionBenchRunner` emits explicit
`unavailable_harness` skip rows for `harness_coding` tasks. When configured,
`fusion-bench` can use a command-compatible HandoffKit seam that receives task JSON
on stdin and returns model-fusion contract records on stdout. Joined rows validate
harness run results, harness candidates, model calls, judge records, artifacts, tool
execution records, receipts, and the benchmark task record before report generation.
ENG-593 reports keep skipped tasks separate from failed tasks.

`fixtures/adversarial-native-fusion/` contains synthetic native FusionKit tasks that
document MVP heuristic-ranker limitations such as keyword and verbosity bait. These
fixtures are for local characterization only and are not public benchmark claims.

## Contamination Policy

- Do not include private customer data, raw secrets, private keys, bearer tokens, or
  proprietary transcripts.
- Do not include answers, golden patches, or patch solutions in task prompts.
- Do not claim dirty-dozen results as public benchmark wins.
- Keep holdout meaning explicit. These seed tasks are synthetic and marked
  `holdout: false`.

## Running

Use the existing manifest path:

```bash
uv run fusionkit fusion-bench \
  --config path/to/config.toml \
  --manifest packages/fusionkit-evals/benchmarks/dirty-dozen \
  --output .fusionkit/dirty-dozen/rows.jsonl \
  --report .fusionkit/dirty-dozen/report.md
```

To validate the manifest matrix in tests, use `load_dirty_dozen_tasks()` and
`assert_dirty_dozen_manifest()` from `fusionkit_evals.dirty_dozen`.
