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
  score, normalized score, confidence, source count, evidence level, and a
  reliability score/grade.
- `SourceSpec`: the extension point for live data sources.

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
        quality_weight=0.7,
    )
)
```

Then call `fetch_live_model_area_scores(sources=("my_source",))`.

## Evidence boundaries

Aggregate rows are useful for shortlisting and routing priors. They are not
proof of uncorrelated errors. Use `TaskOutcome` rows with shared task ids and
shared scoring rules when computing oracle headroom or failure correlations.

## Reliability scoring

Every matrix cell includes:

- `reliability_score`: 0..1 rollup from evidence level, scoring mode, source
  quality, task count, source diversity, same-harness comparability, and
  freshness.
- `reliability_grade`: `high`, `medium`, `low`, or `exploratory`.
- `warnings`: human-readable caveats such as single-source evidence or
  aggregate-proxy evidence.

Call `build_reliability_report(matrix)` to summarize reliability by area and
grade. Source quality is configured on `SourceSpec.quality_weight`, so adding a
new source also requires declaring how trustworthy that source should be treated
relative to the built-ins.
