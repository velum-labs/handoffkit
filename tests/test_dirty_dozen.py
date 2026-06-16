from __future__ import annotations

from collections import Counter
from pathlib import Path
from typing import cast

import pytest
from fusionkit_core.clients import FakeModelClient
from fusionkit_core.config import FusionConfig, ModelEndpoint
from fusionkit_core.contracts import BenchmarkTaskRecordV1
from fusionkit_core.fusion import FusionEngine
from fusionkit_evals.dirty_dozen import (
    DIRTY_DOZEN_REPOS,
    DIRTY_DOZEN_TASK_COUNT,
    DirtyDozenRepo,
    assert_dirty_dozen_manifest,
    load_dirty_dozen_tasks,
)
from fusionkit_evals.fusion_bench import FusionBenchRunner, build_fusion_bench_report


def test_dirty_dozen_loader_validates_manifest_matrix() -> None:
    tasks = load_dirty_dozen_tasks()

    assert_dirty_dozen_manifest(tasks)
    assert len(tasks) == DIRTY_DOZEN_TASK_COUNT
    assert all(isinstance(task.record, BenchmarkTaskRecordV1) for task in tasks)
    assert len({task.record.task_id for task in tasks}) == DIRTY_DOZEN_TASK_COUNT


def test_dirty_dozen_repo_and_task_kind_coverage() -> None:
    tasks = load_dirty_dozen_tasks()
    repo_counts = Counter(task.record.source_repo for task in tasks)
    task_kinds = Counter(task.record.task_kind for task in tasks)

    assert set(repo_counts) == set(DIRTY_DOZEN_REPOS)
    assert all(repo_counts[repo] >= 2 for repo in DIRTY_DOZEN_REPOS)
    assert repo_counts == {
        "fusionkit": 3,
        "handoffkit": 3,
        "cursorkit": 3,
        "mlx-lm": 3,
    }
    assert task_kinds["model_fusion"] >= 1
    assert task_kinds["harness_coding"] >= 1


def test_dirty_dozen_subset_loader_filters_by_repo() -> None:
    tasks = load_dirty_dozen_tasks(repos=["fusionkit", "mlx-lm"])

    assert [task.category for task in tasks] == [
        "fusionkit",
        "fusionkit",
        "fusionkit",
        "mlx-lm",
        "mlx-lm",
        "mlx-lm",
    ]


def test_dirty_dozen_task_policy_fields_are_present() -> None:
    for task in load_dirty_dozen_tasks():
        repo = cast(DirtyDozenRepo, task.record.source_repo)
        params = task.record.scorer.params or {}

        assert task.category == repo
        assert task.record.prompt_hash.startswith("sha256:")
        assert task.record.setup_hash.startswith("sha256:")
        assert task.record.expected_evidence
        assert task.record.allowed_tools
        assert task.record.contamination_notes
        assert "solution" in task.record.contamination_notes
        assert params["dirty_dozen"] is True


def test_dirty_dozen_manifest_rejects_duplicate_task_ids() -> None:
    tasks = load_dirty_dozen_tasks()
    tasks[1] = tasks[1].model_copy(update={"record": tasks[0].record})

    with pytest.raises(ValueError, match="unique"):
        assert_dirty_dozen_manifest(tasks)


def test_dirty_dozen_manifest_rejects_missing_repo_coverage() -> None:
    tasks = [
        task
        for task in load_dirty_dozen_tasks()
        if task.record.source_repo != "mlx-lm"
    ]

    with pytest.raises(ValueError, match="Expected 12"):
        assert_dirty_dozen_manifest(tasks)


@pytest.mark.asyncio
async def test_dirty_dozen_runner_emits_explicit_skips_for_harness_tasks(tmp_path) -> None:
    harness_tasks = [
        task for task in load_dirty_dozen_tasks() if task.record.task_kind == "harness_coding"
    ]
    runner = FusionBenchRunner(
        _engine(),
        run_root=tmp_path / "runs",
        config_id="dirty-dozen",
        mode="single",
    )

    rows = await runner.run_tasks(harness_tasks)

    assert rows
    assert all(row.failure.failure_kind == "unavailable_harness" for row in rows)
    assert all(row.failure.error_code == "harness_unavailable" for row in rows)
    assert all(row.failure.terminal_reason == "ensemble_adapter_not_configured" for row in rows)
    assert all(row.run_id is None for row in rows)


@pytest.mark.asyncio
async def test_dirty_dozen_report_keeps_harness_skips_separate(tmp_path) -> None:
    harness_tasks = [
        task for task in load_dirty_dozen_tasks() if task.record.task_kind == "harness_coding"
    ]
    runner = FusionBenchRunner(
        _engine(),
        run_root=tmp_path / "runs",
        config_id="dirty-dozen",
        mode="single",
    )

    rows = await runner.run_tasks(harness_tasks)
    report = build_fusion_bench_report(rows)

    assert report.aggregate.skipped_tasks == len(harness_tasks)
    assert report.aggregate.failed_tasks == 0
    assert report.aggregate.harness_verification_outcomes == {
        "skipped": len(harness_tasks)
    }


def test_dirty_dozen_readme_documents_setup_scoring_and_contamination() -> None:
    readme_path = (
        Path(__file__).resolve().parents[1]
        / "packages"
        / "fusionkit-evals"
        / "benchmarks"
        / "README.md"
    )
    readme = readme_path.read_text(encoding="utf-8")

    assert "Clean-Checkout Setup" in readme
    assert "Scoring Policy" in readme
    assert "Contamination Policy" in readme
    assert "do not include answers or patch solutions" in readme
    assert "unavailable_harness" in readme


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
        clients={"fast": FakeModelClient("fast", ["metadata trace artifact capability"])},
    )
