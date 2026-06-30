from __future__ import annotations

from collections import Counter
from collections.abc import Iterable
from pathlib import Path
from typing import Literal

from pydantic import BaseModel

from fusionkit_evals.fusion_bench import FusionBenchTask, load_benchmark_tasks

PUBLIC_SMOKE_FIXTURE_ROOT = Path(__file__).resolve().parents[2] / "fixtures" / "public-smoke"
PUBLIC_SMOKE_DISCLAIMER = (
    "public benchmark smoke adapters only; these fixtures are synthetic and do not "
    "support public benchmark claims"
)
PublicSmokeSuite = Literal[
    "swe-bench-lite",
    "aider-polyglot",
    "terminal-bench",
    "livecodebench",
]
PUBLIC_SMOKE_SUITES: tuple[PublicSmokeSuite, ...] = (
    "swe-bench-lite",
    "aider-polyglot",
    "terminal-bench",
    "livecodebench",
)


class PublicSmokeSuiteInfo(BaseModel):
    suite: PublicSmokeSuite
    display_name: str
    fixture_category: str
    smoke_only: bool = True
    public_claim_eligible: bool = False
    requires_external_harness: bool = True
    unsupported_reason: str


PUBLIC_SMOKE_SUITE_INFO: dict[PublicSmokeSuite, PublicSmokeSuiteInfo] = {
    "swe-bench-lite": PublicSmokeSuiteInfo(
        suite="swe-bench-lite",
        display_name="SWE-bench Lite",
        fixture_category="swe-bench-lite",
        unsupported_reason="external_repo_checkout_and_test_harness_not_configured",
    ),
    "aider-polyglot": PublicSmokeSuiteInfo(
        suite="aider-polyglot",
        display_name="Aider polyglot",
        fixture_category="aider-polyglot",
        unsupported_reason="polyglot_edit_harness_not_configured",
    ),
    "terminal-bench": PublicSmokeSuiteInfo(
        suite="terminal-bench",
        display_name="Terminal-Bench",
        fixture_category="terminal-bench",
        unsupported_reason="terminal_sandbox_harness_not_configured",
    ),
    "livecodebench": PublicSmokeSuiteInfo(
        suite="livecodebench",
        display_name="LiveCodeBench",
        fixture_category="livecodebench",
        unsupported_reason="code_execution_harness_not_configured",
    ),
}


def load_public_smoke_tasks(
    root: str | Path = PUBLIC_SMOKE_FIXTURE_ROOT,
    suites: Iterable[PublicSmokeSuite] | None = None,
) -> list[FusionBenchTask]:
    tasks = load_benchmark_tasks(root)
    if suites is None:
        return tasks
    selected = set(suites)
    unknown = selected - set(PUBLIC_SMOKE_SUITES)
    if unknown:
        raise ValueError(f"Unknown public smoke suites: {sorted(unknown)}")
    return [task for task in tasks if task.category in selected]


def assert_public_smoke_matrix(tasks: Iterable[FusionBenchTask]) -> None:
    task_list = list(tasks)
    counts = Counter(task.category for task in task_list)
    missing = [suite for suite in PUBLIC_SMOKE_SUITES if counts[suite] == 0]
    unexpected = sorted(set(counts) - set(PUBLIC_SMOKE_SUITES))
    if missing:
        raise ValueError(f"Missing public smoke suites: {missing}")
    if unexpected:
        raise ValueError(f"Unexpected public smoke suites: {unexpected}")
    holdouts = [task.record.task_id for task in task_list if task.record.holdout]
    if holdouts:
        raise ValueError(f"Public smoke fixtures must not be holdouts: {holdouts}")
    non_smoke = [
        task.record.task_id
        for task in task_list
        if (task.record.scorer.params or {}).get("smoke_only") is not True
    ]
    if non_smoke:
        raise ValueError(f"Public smoke fixtures must be marked smoke_only: {non_smoke}")
    claim_eligible = [
        task.record.task_id
        for task in task_list
        if (task.record.scorer.params or {}).get("public_claim_eligible") is True
    ]
    if claim_eligible:
        raise ValueError(
            f"Public smoke fixtures must not be public-claim eligible: {claim_eligible}"
        )


__all__ = [
    "PUBLIC_SMOKE_DISCLAIMER",
    "PUBLIC_SMOKE_FIXTURE_ROOT",
    "PUBLIC_SMOKE_SUITES",
    "PUBLIC_SMOKE_SUITE_INFO",
    "PublicSmokeSuite",
    "PublicSmokeSuiteInfo",
    "assert_public_smoke_matrix",
    "load_public_smoke_tasks",
]
