from __future__ import annotations

from collections import Counter
from collections.abc import Iterable
from pathlib import Path
from typing import Literal

from fusionkit_evals.fusion_bench import FusionBenchTask, load_benchmark_tasks

DIRTY_DOZEN_ROOT = Path(__file__).resolve().parents[2] / "benchmarks" / "dirty-dozen"
DIRTY_DOZEN_TASK_COUNT = 12
DirtyDozenRepo = Literal["fusionkit", "handoffkit", "cursorkit", "mlx-lm"]
DIRTY_DOZEN_REPOS: tuple[DirtyDozenRepo, ...] = (
    "fusionkit",
    "handoffkit",
    "cursorkit",
    "mlx-lm",
)


def load_dirty_dozen_tasks(
    root: str | Path = DIRTY_DOZEN_ROOT,
    repos: Iterable[DirtyDozenRepo] | None = None,
) -> list[FusionBenchTask]:
    tasks = load_benchmark_tasks(root)
    if repos is None:
        return tasks
    selected = set(repos)
    unknown = selected - set(DIRTY_DOZEN_REPOS)
    if unknown:
        raise ValueError(f"Unknown dirty-dozen repos: {sorted(unknown)}")
    return [task for task in tasks if task.record.source_repo in selected]


def assert_dirty_dozen_manifest(tasks: Iterable[FusionBenchTask]) -> None:
    task_list = list(tasks)
    if len(task_list) != DIRTY_DOZEN_TASK_COUNT:
        raise ValueError(f"Expected 12 dirty-dozen tasks, got {len(task_list)}")
    task_ids = [task.record.task_id for task in task_list]
    duplicate_ids = sorted(
        task_id for task_id, count in Counter(task_ids).items() if count > 1
    )
    if duplicate_ids:
        raise ValueError(f"Dirty-dozen task IDs must be unique: {duplicate_ids}")
    repo_counts = Counter(task.record.source_repo for task in task_list)
    missing_repos = [repo for repo in DIRTY_DOZEN_REPOS if repo_counts[repo] == 0]
    underrepresented = {
        repo: count
        for repo, count in sorted(repo_counts.items())
        if repo in DIRTY_DOZEN_REPOS and count < 2
    }
    unexpected_repos = sorted(set(repo_counts) - set(DIRTY_DOZEN_REPOS))
    if missing_repos:
        raise ValueError(f"Missing dirty-dozen source repos: {missing_repos}")
    if underrepresented:
        raise ValueError(f"Expected at least two tasks per repo, got {underrepresented}")
    if unexpected_repos:
        raise ValueError(f"Unexpected dirty-dozen source repos: {unexpected_repos}")
    task_kinds = {task.record.task_kind for task in task_list}
    if not {"model_fusion", "harness_coding"}.issubset(task_kinds):
        raise ValueError(f"Dirty-dozen must include both task kinds, got {task_kinds}")
    for task in task_list:
        _assert_task_policy(task)


def _assert_task_policy(task: FusionBenchTask) -> None:
    record = task.record
    if record.source_repo != task.category:
        raise ValueError(
            f"Dirty-dozen category {task.category!r} must match source repo "
            f"{record.source_repo!r} for {record.task_id}"
        )
    if not record.expected_evidence:
        raise ValueError(f"Dirty-dozen task must include expected evidence: {record.task_id}")
    if not record.contamination_notes:
        raise ValueError(f"Dirty-dozen task must include contamination notes: {record.task_id}")
    if "solution" not in record.contamination_notes:
        raise ValueError(
            f"Dirty-dozen contamination notes must state no solution is included: "
            f"{record.task_id}"
        )
    if not record.prompt_hash.startswith("sha256:"):
        raise ValueError(f"Dirty-dozen task must include prompt hash: {record.task_id}")
    if not record.setup_hash.startswith("sha256:"):
        raise ValueError(f"Dirty-dozen task must include setup hash: {record.task_id}")
    if not record.allowed_tools:
        raise ValueError(f"Dirty-dozen task must include allowed tools: {record.task_id}")
    params = record.scorer.params or {}
    if params.get("dirty_dozen") is not True:
        raise ValueError(f"Dirty-dozen scorer params must set dirty_dozen: {record.task_id}")


__all__ = [
    "DIRTY_DOZEN_REPOS",
    "DIRTY_DOZEN_ROOT",
    "DIRTY_DOZEN_TASK_COUNT",
    "DirtyDozenRepo",
    "assert_dirty_dozen_manifest",
    "load_dirty_dozen_tasks",
]
