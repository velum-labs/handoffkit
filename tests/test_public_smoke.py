from __future__ import annotations

from pathlib import Path
from typing import cast

import pytest
from fusionkit_core.clients import FakeModelClient
from fusionkit_core.config import FusionConfig, ModelEndpoint
from fusionkit_core.contracts import BenchmarkTaskRecordV1
from fusionkit_core.fusion import FusionEngine
from fusionkit_evals.fusion_bench import FusionBenchRunner, build_fusion_bench_report
from fusionkit_evals.public_smoke import (
    PUBLIC_SMOKE_DISCLAIMER,
    PUBLIC_SMOKE_SUITE_INFO,
    PUBLIC_SMOKE_SUITES,
    PublicSmokeSuite,
    assert_public_smoke_matrix,
    load_public_smoke_tasks,
)


def test_public_smoke_loader_covers_required_suites() -> None:
    tasks = load_public_smoke_tasks()

    assert_public_smoke_matrix(tasks)
    assert len(tasks) == len(PUBLIC_SMOKE_SUITES)
    assert {task.category for task in tasks} == set(PUBLIC_SMOKE_SUITES)
    assert all(isinstance(task.record, BenchmarkTaskRecordV1) for task in tasks)


def test_public_smoke_subset_loader_filters_by_suite() -> None:
    tasks = load_public_smoke_tasks(suites=["swe-bench-lite", "livecodebench"])

    assert [task.category for task in tasks] == ["livecodebench", "swe-bench-lite"]


def test_public_smoke_fixtures_are_smoke_only_and_not_holdouts() -> None:
    for task in load_public_smoke_tasks():
        params = task.record.scorer.params or {}
        suite = cast(PublicSmokeSuite, task.category)
        suite_info = PUBLIC_SMOKE_SUITE_INFO[suite]

        assert task.record.task_kind == "harness_coding"
        assert task.record.holdout is False
        assert params["suite"] == suite
        assert params["smoke_only"] is True
        assert params["public_claim_eligible"] is False
        assert params["requires_external_harness"] is True
        assert params["unsupported_reason"] == suite_info.unsupported_reason
        assert "not eligible for public benchmark claims" in task.record.contamination_notes


def test_public_smoke_matrix_rejects_holdouts() -> None:
    tasks = load_public_smoke_tasks()
    tasks[0] = tasks[0].model_copy(
        update={"record": tasks[0].record.model_copy(update={"holdout": True})}
    )

    with pytest.raises(ValueError, match="must not be holdouts"):
        assert_public_smoke_matrix(tasks)


@pytest.mark.asyncio
async def test_public_smoke_runner_emits_explicit_harness_skips(tmp_path) -> None:
    runner = FusionBenchRunner(
        _engine(),
        run_root=tmp_path / "runs",
        config_id="public-smoke",
        mode="single",
    )

    rows = await runner.run_tasks(load_public_smoke_tasks())

    assert len(rows) == len(PUBLIC_SMOKE_SUITES)
    assert all(row.failure.failure_kind == "unavailable_harness" for row in rows)
    assert all(row.failure.error_code == "harness_unavailable" for row in rows)
    assert all(row.failure.terminal_reason == "ensemble_adapter_not_configured" for row in rows)
    assert all(row.run_id is None for row in rows)


@pytest.mark.asyncio
async def test_public_smoke_report_keeps_skips_separate(tmp_path) -> None:
    runner = FusionBenchRunner(
        _engine(),
        run_root=tmp_path / "runs",
        config_id="public-smoke",
        mode="single",
    )

    rows = await runner.run_tasks(load_public_smoke_tasks())
    report = build_fusion_bench_report(rows)

    assert report.aggregate.total_tasks == len(PUBLIC_SMOKE_SUITES)
    assert report.aggregate.skipped_tasks == len(PUBLIC_SMOKE_SUITES)
    assert report.aggregate.failed_tasks == 0
    assert report.aggregate.succeeded_tasks == 0
    assert report.aggregate.harness_verification_outcomes == {
        "skipped": len(PUBLIC_SMOKE_SUITES)
    }


def test_public_smoke_docs_contain_claim_disclaimer() -> None:
    docs_path = Path(__file__).resolve().parents[1] / "docs" / "public-benchmark-smoke.md"
    docs = docs_path.read_text(encoding="utf-8")

    assert "not public benchmark runs" in docs
    assert "must not download benchmark datasets" in docs
    assert "public_claim_eligible: false" in docs
    assert "unavailable_harness" in docs
    assert PUBLIC_SMOKE_DISCLAIMER.startswith("public benchmark smoke adapters only")


def _engine() -> FusionEngine:
    config = FusionConfig(
        endpoints=[
            ModelEndpoint(
                id="fast",
                model="fake-fast",
                base_url="http://localhost:8101",
            ),
        ],
        default_model="fast",
        default_mode="single",
    )
    return FusionEngine(
        config=config,
        clients={"fast": FakeModelClient("fast", ["unused"])},
    )
