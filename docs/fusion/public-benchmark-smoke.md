# Public Benchmark Smoke Adapters

ENG-594 adds local smoke adapters for public benchmark suites. These fixtures prove
that FusionKit can normalize suite-shaped tasks into `benchmark-task-record.v1` and
feed them through `fusion-bench` reports. They are not public benchmark runs.

## Suites

| Suite | Fixture category | Current status | Public claims |
| --- | --- | --- | --- |
| SWE-bench Lite | `swe-bench-lite` | Smoke fixture only; external repo/test harness unavailable | No |
| Aider polyglot | `aider-polyglot` | Smoke fixture only; polyglot edit harness unavailable | No |
| Terminal-Bench | `terminal-bench` | Smoke fixture only; terminal sandbox harness unavailable | No |
| LiveCodeBench | `livecodebench` | Smoke fixture only; code execution harness unavailable | No |

## Rules

- Default CI must not download benchmark datasets, clone public benchmark repos, or
  require external credentials.
- Checked-in smoke fixtures are synthetic and license-safe. They must not copy public
  benchmark prompts, private tasks, or holdout content.
- Every public smoke fixture must set `holdout: false`, `smoke_only: true`, and
  `public_claim_eligible: false`.
- Real public benchmark claims require a future harness that runs the official suite,
  uses uncontaminated tasks, preserves suite licensing, and records full provenance.

## Running

The existing manifest path is enough:

```bash
uv run fusionkit fusion-bench \
  --config path/to/config.toml \
  --manifest packages/fusionkit-evals/fixtures/public-smoke \
  --output .fusionkit/public-smoke/rows.jsonl \
  --report .fusionkit/public-smoke/report.md
```

These tasks are `harness_coding` records. Without a configured HandoffKit executor,
`FusionBenchRunner` emits explicit `unavailable_harness` skip rows for them, and the
ENG-593 report layer keeps skipped tasks separate from failed tasks. Running a local
fake or command executor for smoke coverage still does not make these fixtures
eligible for public benchmark claims.
