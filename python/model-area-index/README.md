# model-area-index

Standalone, no-run model capability indexing for panel selection and routing
priors. The package treats public benchmarks as a small metadata warehouse:
task catalog first, task outcomes second, and model-area summaries as derived
rollups only.

## Core concepts

- `ModelAreaScore`: one public benchmark signal for one model in one area.
  Besides the display `model_key`, each row also carries canonical identity
  hints: `base_model_key`, `provider_model_id`, `model_alias`,
  `reasoning_effort`, `harness_or_agent`, `is_agent_system`, and
  `is_open_weight`.
- `TaskOutcome`: per-task same-harness outcome rows, used only when true
  oracle/headroom or failure-correlation metrics are justified.
- `BenchmarkTask`: task catalog metadata used for slicing and planning.
- `ModelAnswerArtifact`: pointer to raw completions, patches, traces, or logs.
- `TaskSlice`: named metadata query for a task subset.
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
- LiveBench model judgments via the Hugging Face dataset server
- Artificial Analysis API (requires `ARTIFICIAL_ANALYSIS_API_KEY`; tolerant
  fetch mode records a source failure when the key is absent)

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
            data_level="aggregate_score",
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

Evidence levels are explicit:

- `aggregate_score`: published benchmark/sub-benchmark score.
- `subtask_score`: score for a difficulty/language/domain slice.
- `task_metadata_only`: task exists, but no public model outcome.
- `model_answer`: public output exists and may be re-graded.
- `task_outcome`: exact model-task-harness score.
- `same_run_task_outcome`: your own paired same-run result.

Aggregate and subtask rows are useful for shortlisting and routing priors. They
are not proof of uncorrelated errors. Use `TaskOutcome` rows with shared task
ids and shared scoring rules when computing oracle headroom or failure
correlations.

## Identity boundaries

The package stores model identity facets separately so downstream analysis can
avoid treating wrappers and reasoning-effort variants as independent model
families. The built-in inference is still conservative metadata extraction, not
a vendor-authoritative alias database. For high-stakes analysis, prefer source
rows that provide explicit provider model IDs and override the identity fields in
the parser.

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

The grouping rule is strict: correlation metrics require shared benchmark,
version, harness, evaluator, attempt budget, output type, area, and subarea.

Use `--write-task-catalog` to fetch public `BenchmarkTask` metadata from sources
that expose task ids. Use `--task-catalog-snapshot` with `--task-outcome-snapshot`
to emit a `benchmark_warehouse_report`.

Panel recommendations use those `TaskOutcomePanelMetrics` when supplied. Without
task outcomes, the recommender applies only an aggregate capability-vector
similarity penalty, which is a weak diversity proxy and is reported as such in
the recommendation reason.
