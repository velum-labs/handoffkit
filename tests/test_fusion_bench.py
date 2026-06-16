from __future__ import annotations

import asyncio
import json

import pytest
from fusionkit_core.artifacts import LocalArtifactStore
from fusionkit_core.clients import FakeModelClient
from fusionkit_core.config import CostMetadata, FusionConfig, ModelEndpoint
from fusionkit_core.contracts import BenchmarkTaskRecordV1, FusionRunRequestV1, contract_metadata
from fusionkit_core.fusion import FusionEngine
from fusionkit_core.run import FusionRunManager
from fusionkit_core.run_store import FileSystemRunStore
from fusionkit_evals.fusion_bench import (
    FusionBenchFailure,
    FusionBenchRunner,
    join_run_records,
    load_benchmark_tasks,
    load_fusion_bench_jsonl,
    skip_row,
    write_fusion_bench_jsonl,
)


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
