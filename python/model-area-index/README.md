# model-area-index

Standalone, no-run model capability indexing for panel selection and routing
priors. The package fetches public benchmark artifacts, normalizes them into
`ModelAreaScore` rows, builds model-by-area matrices, and keeps aggregate
capability evidence separate from same-task outcome evidence.

## Core concepts

- `ModelAreaScore`: one public benchmark signal for one model in one area.
- `TaskOutcome`: per-task same-harness outcome rows, used only when true
  oracle/headroom or failure-correlation metrics are justified.
- `ModelAreaMatrix`: rows are models, columns are areas, cells include raw
  score, normalized score, confidence, source count, evidence level, and
  warnings.
- `SourceSpec`: the extension point for live data sources.
- `DataQualityReport`: concrete validation results for row-level issues before
  a matrix is trusted.

## Built-in sources

Built-ins are registered through the same source registry exposed to callers:

- Aider polyglot
- SWE-bench
- Terminal-Bench
- LiveCodeBench generation / execution / repair / test generation
- BenchLM category leaderboards
- Hugging Face Open LLM Leaderboard
- UIBenchKit DCGen / Design2Code

## Add a source

Registering a new source does not require editing the fetch loop:

```python
from model_area_index import ModelAreaScore, SourceSpec, register_source


def parse_my_source(text, source_url, snapshot_hash, retrieved_at, limit):
    # Parse text/JSON/CSV/HTML and return ModelAreaScore rows.
    return [
        ModelAreaScore(
            model_key="example-model",
            provider="example",
            model_family="example",
            model_version_or_alias="example-model",
            benchmark="my-benchmark",
            benchmark_version="2026-07",
            area="systems_design",
            score_raw=0.71,
            score_normalized=0.71,
            date_observed=retrieved_at,
            source_url=source_url,
            source_snapshot_hash=snapshot_hash,
            data_level="aggregate",
            scoring="objective",
        )
    ]


register_source(
    SourceSpec(
        source="my_source",
        url="https://example.com/results.json",
        parser=parse_my_source,
        areas=("systems_design",),
        description="Example systems-design benchmark.",
    )
)
```

Then call `fetch_live_model_area_scores(sources=("my_source",))`.

Live fetches are tolerant by default: one source failure is captured in
`source_metadata` and the remaining sources still produce a matrix. Use
`strict=True` in Python or `--strict` in the CLI when CI should fail on any
source failure.

## Evidence boundaries

Aggregate rows are useful for shortlisting and routing priors. They are not
proof of uncorrelated errors. Use `TaskOutcome` rows with shared task ids and
shared scoring rules when computing oracle headroom or failure correlations.

## Data-quality validation

Call `build_data_quality_report(scores)` before trusting a snapshot. The report
checks concrete failure modes:

- rows from unknown source URLs;
- sources emitting areas they did not advertise;
- duplicate model/benchmark/version/area/subarea/source rows;
- unknown providers;
- task-outcome rows that are not marked same-harness comparable;
- higher-evidence rows that are missing task counts.

The CLI includes `data_quality_report` in JSON output and supports
`--fail-on-data-quality-errors` for CI gates.

Full live-pulled snapshots can be large. Keep large `latest` outputs as CI,
release, or local artifacts; commit only small reviewed fixtures such as
`fixtures/model_area_scores.sample.jsonl`.

## Task-outcome evidence

Do not put per-task evidence into `ModelAreaScore` unless it is still only an
aggregate/subtask score for the matrix. Real same-task evidence belongs in
`TaskOutcome` rows. The CLI accepts `--task-outcome-snapshot <jsonl>` and emits
separate `task_outcome_metrics` with oracle score, oracle headroom, unique-win
rates, and pairwise failure correlations.
