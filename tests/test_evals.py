from __future__ import annotations

from pathlib import Path

import pytest
from fusionkit_core.clients import FakeModelClient
from fusionkit_core.config import FusionConfig, ModelEndpoint
from fusionkit_core.contracts import BenchmarkTaskRecordV1
from fusionkit_core.fusion import FusionEngine
from fusionkit_evals.pareto import ParetoPoint, find_pareto_front, write_pareto_report
from fusionkit_evals.scorers import contains_expected, exact_match
from fusionkit_evals.tiny import (
    DISCLAIMER,
    TinyBenchmarkMetrics,
    TinyBenchmarkResult,
    assert_tiny_task_matrix,
    format_tiny_benchmark_report,
    load_tiny_results,
    load_tiny_tasks,
    run_tiny_benchmark,
    write_tiny_jsonl,
)


def test_scorers() -> None:
    assert exact_match("Answer", "answer") == 1.0
    assert contains_expected("The answer is Paris.", "paris") == 1.0
    assert contains_expected("The answer is Rome.", "paris") == 0.0


def test_pareto_front_filters_dominated_points() -> None:
    points = [
        ParetoPoint(id="slow-good", quality=0.9, latency_s=10.0, peak_memory_gb=8.0),
        ParetoPoint(id="fast-good", quality=0.9, latency_s=5.0, peak_memory_gb=8.0),
        ParetoPoint(id="fast-bad", quality=0.5, latency_s=5.0, peak_memory_gb=8.0),
    ]

    front = find_pareto_front(points)

    assert [point.id for point in front] == ["fast-good"]


def test_pareto_markdown_report_marks_frontier(tmp_path) -> None:
    output = tmp_path / "pareto.md"
    points = [
        ParetoPoint(id="dominated", quality=0.5, latency_s=5.0),
        ParetoPoint(id="frontier", quality=0.8, latency_s=4.0),
    ]

    write_pareto_report(output, points)

    markdown = output.read_text()
    assert "| frontier | yes |" in markdown
    assert "| dominated | no |" in markdown


def test_tiny_benchmark_fixture_matrix_validates() -> None:
    tasks = load_tiny_tasks()
    assert_tiny_task_matrix(tasks)
    counts = {}
    for task in tasks:
        counts[task.category] = counts.get(task.category, 0) + 1
        assert BenchmarkTaskRecordV1.model_validate(task.record.model_dump(mode="json"))

    assert len(tasks) == 25
    assert counts == {
        "code-microtasks": 5,
        "factual-qa": 5,
        "json-tasks": 5,
        "read-only-tool-loop": 5,
        "tool-choice": 5,
    }


def test_tiny_benchmark_malformed_fixture_is_rejected(tmp_path) -> None:
    fixture_root = tmp_path / "tiny-phase1"
    category = fixture_root / "factual-qa"
    category.mkdir(parents=True)
    (category / "bad.json").write_text('{"schema":"benchmark-task-record.v1"}')

    with pytest.raises(ValueError):
        load_tiny_tasks(fixture_root)


def test_contract_benchmark_fixture_matrix_remains_compatibility_sized() -> None:
    contract_fixture_dir = (
        Path(__file__).resolve().parents[1]
        / "spec"
        / "model-fusion-contract"
        / "fixture"
        / "benchmark-task-record.v1"
    )

    assert sorted(path.name for path in contract_fixture_dir.glob("*.json")) == [
        "minimal.json",
        "realistic.json",
    ]


@pytest.mark.asyncio
async def test_tiny_benchmark_runner_writes_required_jsonl_fields(tmp_path) -> None:
    tasks = load_tiny_tasks()[:2]
    engine = FusionEngine(
        config=FusionConfig(
            endpoints=[ModelEndpoint(id="fast", model="fake-fast", base_url="http://localhost:8101")],
            default_model="fast",
            default_mode="single",
        ),
        clients={"fast": FakeModelClient("fast", ["Paris", '{"color":"blue","count":3}'])},
    )

    results = await run_tiny_benchmark(
        engine,
        config_id="test",
        mode="single",
        tasks=tasks,
        model_versions={"fast": "fake-fast"},
    )
    output = tmp_path / "tiny.jsonl"
    write_tiny_jsonl(output, results)
    loaded = load_tiny_results(output)

    assert len(loaded) == 2
    assert loaded[0].schema_bundle_hash.startswith("sha256:")
    assert loaded[0].repo_sha
    assert loaded[0].model_versions == {"fast": "fake-fast"}
    assert loaded[0].run_ids == [None]
    assert loaded[0].task["schema"] == "benchmark-task-record.v1"


def test_tiny_benchmark_report_contains_required_summaries(tmp_path) -> None:
    result = load_tiny_results_from_model()

    markdown = format_tiny_benchmark_report(result)

    assert DISCLAIMER in markdown
    assert "Synthesized success" in markdown
    assert "Best single success" in markdown
    assert "Oracle success" in markdown
    assert "Cost estimate" in markdown
    assert "Latency" in markdown
    assert "Schema validity" in markdown
    assert "Tool-call validity" in markdown


def load_tiny_results_from_model():
    task = load_tiny_tasks()[0]
    engine_result = task.record.model_dump(mode="json")
    return [
        TinyBenchmarkResult(
            task_id=task.record.task_id,
            category=task.category,
            config_id="test",
            mode="single",
            output="Paris",
            schema_bundle_hash="sha256:" + "1" * 64,
            repo_sha="a" * 40,
            model_versions={"fast": "fake-fast"},
            run_ids=[None],
            metrics=TinyBenchmarkMetrics(
                best_single_success=1.0,
                oracle_success=1.0,
                synthesized_success=1.0,
                cost_estimate=None,
                latency_s=0.01,
                schema_validity=1.0,
                tool_call_validity=None,
            ),
            task=engine_result,
        )
    ]
