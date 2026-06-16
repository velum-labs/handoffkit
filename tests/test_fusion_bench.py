from __future__ import annotations

import asyncio
import json

import pytest
from fusionkit_cli.main import app
from fusionkit_core.artifacts import LocalArtifactStore
from fusionkit_core.clients import FakeModelClient
from fusionkit_core.config import CostMetadata, FusionConfig, ModelEndpoint
from fusionkit_core.contracts import BenchmarkTaskRecordV1, FusionRunRequestV1, contract_metadata
from fusionkit_core.fusion import FusionEngine
from fusionkit_core.run import FusionRunManager
from fusionkit_core.run_store import FileSystemRunStore
from fusionkit_evals.fusion_bench import (
    FUSION_BENCH_DISCLAIMER,
    FusionBenchAttemptRow,
    FusionBenchFailure,
    FusionBenchRunner,
    build_fusion_bench_report,
    format_fusion_bench_html_report,
    format_fusion_bench_markdown_report,
    join_run_records,
    load_benchmark_tasks,
    load_fusion_bench_jsonl,
    score_fusion_bench_row,
    skip_row,
    write_fusion_bench_html_report,
    write_fusion_bench_jsonl,
    write_fusion_bench_markdown_report,
    write_fusion_bench_report_jsonl,
)
from typer.testing import CliRunner


def test_fusion_bench_loads_tiny_manifests() -> None:
    tasks = load_benchmark_tasks()

    assert len(tasks) == 25
    assert all(isinstance(task.record, BenchmarkTaskRecordV1) for task in tasks)


def test_fusion_bench_missing_manifest_fails_clearly(tmp_path) -> None:
    with pytest.raises(FileNotFoundError):
        load_benchmark_tasks(tmp_path / "missing")


@pytest.mark.asyncio
async def test_fusion_bench_runs_native_task_and_joins_records(tmp_path) -> None:
    task = next(task for task in load_benchmark_tasks() if task.record.task_kind == "model_fusion")
    runner = FusionBenchRunner(
        _engine(),
        run_root=tmp_path / "runs",
        config_id="test",
        mode="single",
        model_versions={"fast": "fake-fast"},
    )

    rows = await runner.run_tasks([task])

    assert len(rows) == 1
    row = rows[0]
    assert row.failure.failure_kind == "none"
    assert row.run_id
    assert row.trace_id
    assert row.fusion_record is not None
    assert row.model_call_records
    assert row.judge_synthesis_record is None
    assert row.artifact_records
    assert row.provider_metadata
    assert row.cost_estimate is not None
    assert row.schema_bundle_hash.startswith("sha256:")
    assert row.repo_sha
    assert row.model_versions == {"fast": "fake-fast"}
    assert row.manifest_hash.startswith("sha256:")
    assert all(
        "candidate with evidence" not in json.dumps(record)
        for record in row.artifact_records
    )
    assert "candidate with evidence" not in json.dumps(row.task_record)


@pytest.mark.asyncio
async def test_fusion_bench_emits_explicit_skip_for_harness_task(tmp_path) -> None:
    task = next(
        task for task in load_benchmark_tasks() if task.record.task_kind == "harness_coding"
    )
    runner = FusionBenchRunner(
        _engine(),
        run_root=tmp_path / "runs",
        config_id="test",
        mode="single",
    )

    rows = await runner.run_tasks([task])

    assert rows[0].failure.failure_kind == "unavailable_harness"
    assert rows[0].failure.owner == "handoffkit"
    assert rows[0].model_versions == {}
    assert rows[0].run_id is None


@pytest.mark.asyncio
async def test_fusion_bench_jsonl_round_trips_rows(tmp_path) -> None:
    tasks = load_benchmark_tasks()[:2]
    runner = FusionBenchRunner(
        _engine(),
        run_root=tmp_path / "runs",
        config_id="test",
        mode="single",
    )
    rows = await runner.run_tasks(tasks)
    output = tmp_path / "rows.jsonl"

    write_fusion_bench_jsonl(output, rows)
    loaded = load_fusion_bench_jsonl(output)

    assert loaded == rows


def test_join_run_records_does_not_require_raw_transcripts(tmp_path) -> None:
    task = next(task for task in load_benchmark_tasks() if task.record.task_kind == "model_fusion")
    store = FileSystemRunStore(tmp_path / "runs")
    manager = FusionRunManager(_engine(), store, LocalArtifactStore(tmp_path / "runs"))
    run_request = FusionRunRequestV1.model_validate(
        {
            **contract_metadata("fusion-run-request.v1"),
            "request_id": "bench_join_test",
            "mode": "single",
            "messages": [{"role": "user", "content": task.record.prompt or ""}],
            "sampling": {},
            "verify": False,
        }
    )

    created = manager.create_run(run_request)
    assert created.run_id is not None

    inspection = asyncio.run(manager.execute_run(created.run_id))
    row = join_run_records(
        task,
        store.list_events(inspection.run_id),
        inspection,
        config_id="test",
        mode="single",
    )

    assert row.model_call_records
    assert row.fusion_record is not None


def test_fusion_bench_skip_row_can_use_custom_failure() -> None:
    task = next(
        task for task in load_benchmark_tasks() if task.record.task_kind == "harness_coding"
    )

    row = skip_row(
        task,
        config_id="test",
        mode="panel",
        failure=FusionBenchFailure(
            failure_kind="unavailable_provider",
            error_code="provider_missing",
            owner="fusionkit",
            terminal_reason="provider_not_configured",
        ),
    )

    assert row.failure.failure_kind == "unavailable_provider"
    assert row.failure.error_code == "provider_missing"


def test_fusion_bench_scores_hand_checked_task_metrics() -> None:
    row = _report_row(
        "task_a",
        output="good",
        candidate_outputs={"fast": "good", "slow": "bad"},
        tool_statuses=["succeeded", "failed"],
    )

    metrics = score_fusion_bench_row(row)

    assert metrics.synthesized_success == 1.0
    assert metrics.best_single_success == 1.0
    assert metrics.random_success == 0.5
    assert metrics.oracle_success == 1.0
    assert metrics.judge_synthesis_regret == 0.0
    assert metrics.tool_success == 0.5
    assert metrics.candidate_failure_rate == 0.5
    assert metrics.candidate_failures == {"fast": False, "slow": True}


def test_fusion_bench_skipped_rows_do_not_contribute_candidate_metrics() -> None:
    row = _report_row(
        "task_skipped_with_calls",
        output=None,
        candidate_outputs={"fast": "good"},
        failure=FusionBenchFailure(
            failure_kind="unavailable_harness",
            error_code="harness_unavailable",
            owner="handoffkit",
            terminal_reason="ensemble_adapter_not_configured",
        ),
        run_id=None,
    )

    metrics = score_fusion_bench_row(row)

    assert metrics.skipped is True
    assert metrics.best_single_success is None
    assert metrics.random_success is None
    assert metrics.oracle_success is None
    assert metrics.candidate_failures == {}


def test_fusion_bench_report_aggregates_metrics_and_outcomes() -> None:
    rows = _report_rows()

    report = build_fusion_bench_report(rows)

    assert report.aggregate.total_tasks == 4
    assert report.aggregate.succeeded_tasks == 2
    assert report.aggregate.skipped_tasks == 1
    assert report.aggregate.failed_tasks == 1
    assert report.aggregate.unscored_tasks == 2
    assert report.aggregate.synthesized_success == 0.5
    assert report.aggregate.best_single_success == 1.0
    assert report.aggregate.random_success == 0.5
    assert report.aggregate.oracle_success == 1.0
    assert report.aggregate.judge_synthesis_regret == 0.5
    assert report.aggregate.tool_success == 0.5
    assert report.aggregate.candidate_failure_rate == 0.5
    assert report.aggregate.failure_kinds["unavailable_harness"] == 1
    assert report.aggregate.harness_verification_outcomes == {
        "succeeded": 2,
        "skipped": 1,
        "failed": 1,
    }
    assert len(report.quality_cost_points) == 2
    assert len(report.quality_latency_points) == 2

    correlation = report.failure_correlations[0]
    assert correlation.left_model_id == "fast"
    assert correlation.right_model_id == "slow"
    assert correlation.n == 2
    assert correlation.correlation == pytest.approx(-1.0)


def test_fusion_bench_report_writers_do_not_include_raw_prompts(tmp_path) -> None:
    rows = _report_rows()
    report = build_fusion_bench_report(rows)
    jsonl_output = tmp_path / "report.jsonl"
    markdown_output = tmp_path / "report.md"
    html_output = tmp_path / "report.html"

    write_fusion_bench_report_jsonl(jsonl_output, report)
    write_fusion_bench_markdown_report(markdown_output, report)
    write_fusion_bench_html_report(html_output, report)

    jsonl_lines = [
        json.loads(line)
        for line in jsonl_output.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    assert jsonl_lines[0]["record_type"] == "metadata"
    assert jsonl_lines[1]["record_type"] == "aggregate"
    assert any(line["record_type"] == "task_metrics" for line in jsonl_lines)
    assert "SECRET_PROMPT" not in jsonl_output.read_text(encoding="utf-8")

    markdown = markdown_output.read_text(encoding="utf-8")
    html = html_output.read_text(encoding="utf-8")
    assert FUSION_BENCH_DISCLAIMER in markdown
    assert "- Skipped tasks: 1" in markdown
    assert "- Failed tasks: 1" in markdown
    assert "Quality vs Cost" in markdown
    assert "SECRET_PROMPT" not in markdown
    assert "SECRET_PROMPT" not in html


def test_fusion_bench_report_formatters_accept_rows() -> None:
    rows = _report_rows()

    markdown = format_fusion_bench_markdown_report(rows)
    html = format_fusion_bench_html_report(rows)

    assert "Fusion Bench Report" in markdown
    assert "Pairwise Failure Correlation" in markdown
    assert "<!doctype html>" in html


def test_fusion_bench_report_cli_writes_markdown_and_jsonl(tmp_path) -> None:
    input_path = tmp_path / "rows.jsonl"
    jsonl_output = tmp_path / "report.jsonl"
    markdown_output = tmp_path / "report.md"
    write_fusion_bench_jsonl(input_path, _report_rows())
    runner = CliRunner()

    result = runner.invoke(
        app,
        [
            "fusion-bench-report",
            "--input",
            str(input_path),
            "--jsonl",
            str(jsonl_output),
            "--markdown",
            str(markdown_output),
        ],
    )

    assert result.exit_code == 0
    response = json.loads(result.stdout)
    assert response["rows"] == 4
    assert response["skipped"] == 1
    assert response["failed"] == 1
    assert jsonl_output.exists()
    assert markdown_output.exists()
    assert "Skipped tasks: 1" in markdown_output.read_text(encoding="utf-8")


def _engine() -> FusionEngine:
    config = FusionConfig(
        endpoints=[
            ModelEndpoint(
                id="fast",
                model="fake-fast",
                base_url="http://localhost:8101",
                pricing=CostMetadata(input_per_1m_tokens=1.0, output_per_1m_tokens=1.0),
            ),
        ],
        default_model="fast",
        default_mode="single",
    )
    return FusionEngine(
        config=config,
        clients={"fast": FakeModelClient("fast", ["candidate with evidence"])},
    )


def _report_rows() -> list[FusionBenchAttemptRow]:
    return [
        _report_row(
            "task_a",
            output="good",
            candidate_outputs={"fast": "good", "slow": "bad"},
            tool_statuses=["succeeded", "failed"],
        ),
        _report_row(
            "task_b",
            output="bad",
            candidate_outputs={"fast": "bad", "slow": "good"},
        ),
        _report_row(
            "task_skipped",
            output=None,
            candidate_outputs={},
            status=None,
            failure=FusionBenchFailure(
                failure_kind="unavailable_harness",
                error_code="harness_unavailable",
                owner="handoffkit",
                terminal_reason="ensemble_adapter_not_configured",
            ),
            run_id=None,
        ),
        _report_row(
            "task_failed",
            output=None,
            candidate_outputs={},
            status="failed",
            failure=FusionBenchFailure(
                failure_kind="run_failed",
                error_code="provider_error",
                owner="fusionkit",
                terminal_reason="provider_error",
            ),
        ),
    ]


def _report_row(
    task_id: str,
    *,
    output: str | None,
    candidate_outputs: dict[str, str],
    tool_statuses: list[str] | None = None,
    status: str | None = "succeeded",
    failure: FusionBenchFailure | None = None,
    run_id: str | None = "run_report",
) -> FusionBenchAttemptRow:
    return FusionBenchAttemptRow(
        task_id=task_id,
        category="synthetic",
        task_kind="model_fusion",
        manifest_path=f"/fixtures/{task_id}.json",
        manifest_hash="sha256:" + "1" * 64,
        schema_bundle_hash="sha256:" + "2" * 64,
        repo_sha="a" * 40,
        config_id="test",
        mode="panel",
        model_versions={"fast": "fake-fast", "slow": "fake-slow"},
        run_id=run_id,
        trace_id="trace_report" if run_id is not None else None,
        state="completed" if status == "succeeded" else None,
        status=status,
        output=output,
        failure=failure or FusionBenchFailure(),
        task_record=_task_record(task_id),
        model_call_records=[
            {
                "call_id": f"{model_id}_{task_id}",
                "endpoint_id": model_id,
                "model": f"fake-{model_id}",
                "output_text": candidate_output,
            }
            for model_id, candidate_output in candidate_outputs.items()
        ],
        tool_records=[
            {
                "schema": "tool-execution-record.v1",
                "execution_id": f"exec_{index}",
                "plan_id": f"plan_{index}",
                "status": tool_status,
            }
            for index, tool_status in enumerate(tool_statuses or [])
        ],
        provider_metadata=[{"cost_estimate": 0.2}],
        model_ids=list(candidate_outputs),
        cost_estimate=0.2 if output is not None else None,
        latency_s=1.0 if output is not None else None,
    )


def _task_record(task_id: str) -> dict[str, object]:
    return {
        "schema": "benchmark-task-record.v1",
        "schema_version": "v1",
        "task_id": task_id,
        "task_kind": "model_fusion",
        "source_repo": "fusionkit",
        "source_sha": "b" * 40,
        "prompt_hash": "sha256:" + "3" * 64,
        "setup_hash": "sha256:" + "4" * 64,
        "expected_evidence": ["synthetic"],
        "scorer": {"kind": "exact", "params": {"expected": "good"}},
        "holdout": False,
        "contamination_notes": "synthetic",
        "allowed_tools": [],
        "prompt": "SECRET_PROMPT should not appear in reports",
    }
