from __future__ import annotations

import json
import time
from collections import Counter
from collections.abc import Callable, Iterable, Mapping
from pathlib import Path
from typing import Any

from fusionkit_core.contracts import (
    BenchmarkTaskRecordV1,
    FusionMode,
    producer_git_sha,
    schema_bundle_hash,
)
from fusionkit_core.fusion import FusionEngine
from fusionkit_core.types import ChatMessage
from pydantic import BaseModel, Field

from fusionkit_evals.scorers import contains_expected, exact_match

TINY_FIXTURE_ROOT = Path(__file__).resolve().parents[2] / "fixtures" / "tiny-phase1"
DISCLAIMER = "tiny synthetic Phase 1 smoke gate; not public benchmark performance"

Scorer = Callable[[str, str | None], float | None]


class TinyBenchmarkTask(BaseModel):
    category: str
    path: Path
    record: BenchmarkTaskRecordV1


class TinyBenchmarkMetrics(BaseModel):
    best_single_success: float | None = None
    oracle_success: float | None = None
    synthesized_success: float | None = None
    cost_estimate: float | None = None
    latency_s: float | None = None
    schema_validity: float
    tool_call_validity: float | None = None


class TinyBenchmarkResult(BaseModel):
    task_id: str
    category: str
    config_id: str
    mode: str
    output: str
    schema_bundle_hash: str
    repo_sha: str
    model_versions: dict[str, str] = Field(default_factory=dict)
    run_ids: list[str | None] = Field(default_factory=list)
    metrics: TinyBenchmarkMetrics
    task: dict[str, Any]


def load_tiny_tasks(root: str | Path = TINY_FIXTURE_ROOT) -> list[TinyBenchmarkTask]:
    root_path = Path(root)
    tasks = []
    for path in sorted(root_path.glob("*/*.json")):
        category = path.parent.name
        task = BenchmarkTaskRecordV1.model_validate_json(path.read_text(encoding="utf-8"))
        tasks.append(TinyBenchmarkTask(category=category, path=path, record=task))
    return tasks


def assert_tiny_task_matrix(tasks: Iterable[TinyBenchmarkTask]) -> None:
    counts = Counter(task.category for task in tasks)
    expected = {
        "factual-qa",
        "json-tasks",
        "tool-choice",
        "read-only-tool-loop",
        "code-microtasks",
    }
    if set(counts) != expected:
        raise ValueError(f"Unexpected tiny benchmark categories: {dict(counts)}")
    bad_counts = {category: count for category, count in counts.items() if count != 5}
    if bad_counts:
        raise ValueError(f"Expected 5 tasks per category, got {bad_counts}")


async def run_tiny_benchmark(
    engine: FusionEngine,
    *,
    config_id: str,
    mode: FusionMode,
    tasks: Iterable[TinyBenchmarkTask] | None = None,
    model_versions: Mapping[str, str] | None = None,
) -> list[TinyBenchmarkResult]:
    selected_tasks = list(tasks if tasks is not None else load_tiny_tasks())
    results = []
    for task in selected_tasks:
        started = time.perf_counter()
        fusion_result = await engine.run(
            [ChatMessage(role="user", content=task.record.prompt or "")],
            mode=mode,
        )
        latency_s = time.perf_counter() - started
        metrics = score_tiny_output(
            task.record,
            fusion_result.content,
            latency_s=latency_s,
            candidate_outputs=[
                trajectory.content for trajectory in fusion_result.trajectories
            ],
            cost_estimate=_optional_float(fusion_result.metrics.get("cost_estimate")),
        )
        results.append(
            TinyBenchmarkResult(
                task_id=task.record.task_id,
                category=task.category,
                config_id=config_id,
                mode=mode,
                output=fusion_result.content,
                schema_bundle_hash=schema_bundle_hash(),
                repo_sha=producer_git_sha(),
                model_versions=dict(model_versions or {}),
                run_ids=[_optional_run_id(fusion_result.metrics)],
                metrics=metrics,
                task=task.record.model_dump(mode="json"),
            )
        )
    return results


def score_tiny_output(
    task: BenchmarkTaskRecordV1,
    output: str,
    *,
    latency_s: float | None,
    candidate_outputs: Iterable[str] = (),
    cost_estimate: float | None = None,
) -> TinyBenchmarkMetrics:
    synthesized_success = _score_by_task(task, output)
    candidate_scores = [
        score
        for candidate_output in candidate_outputs
        if (score := _score_by_task(task, candidate_output)) is not None
    ]
    schema_validity = _schema_validity(task, output)
    tool_call_validity = _tool_call_validity(task, output)
    oracle_scores = [
        score for score in [synthesized_success, *candidate_scores] if score is not None
    ]
    return TinyBenchmarkMetrics(
        best_single_success=max(candidate_scores, default=None),
        oracle_success=max(oracle_scores, default=None),
        synthesized_success=synthesized_success,
        cost_estimate=cost_estimate,
        latency_s=latency_s,
        schema_validity=schema_validity,
        tool_call_validity=tool_call_validity,
    )


def write_tiny_jsonl(path: str | Path, results: Iterable[TinyBenchmarkResult]) -> None:
    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        for result in results:
            handle.write(json.dumps(result.model_dump(mode="json")) + "\n")


def load_tiny_results(path: str | Path) -> list[TinyBenchmarkResult]:
    with Path(path).open(encoding="utf-8") as handle:
        return [TinyBenchmarkResult.model_validate_json(line) for line in handle if line.strip()]


def write_tiny_benchmark_report(path: str | Path, results: Iterable[TinyBenchmarkResult]) -> None:
    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(format_tiny_benchmark_report(results), encoding="utf-8")


def format_tiny_benchmark_report(results: Iterable[TinyBenchmarkResult]) -> str:
    result_list = list(results)
    by_category = Counter(result.category for result in result_list)
    lines = [
        "# Tiny Phase 1 Benchmark Report",
        "",
        f"Disclaimer: {DISCLAIMER}.",
        "",
        "## Summary",
        "",
        f"- Tasks: {len(result_list)}",
        f"- Synthesized success: {_average_metric(result_list, 'synthesized_success')}",
        f"- Best single success: {_average_metric(result_list, 'best_single_success')}",
        f"- Oracle success: {_average_metric(result_list, 'oracle_success')}",
        f"- Cost estimate: {_average_metric(result_list, 'cost_estimate')}",
        f"- Latency: {_average_metric(result_list, 'latency_s')}",
        f"- Schema validity: {_average_metric(result_list, 'schema_validity')}",
        f"- Tool-call validity: {_average_metric(result_list, 'tool_call_validity')}",
        "",
        "## Categories",
        "",
    ]
    for category, count in sorted(by_category.items()):
        lines.append(f"- {category}: {count}")
    lines.extend(
        [
            "",
            "## Task Results",
            "",
            "| Task | Category | Synthesized | Best Single | Oracle | Latency |",
            "| --- | --- | ---: | ---: | ---: | ---: |",
        ]
    )
    for result in result_list:
        lines.append(
            "| "
            f"{result.task_id} | "
            f"{result.category} | "
            f"{_format_metric(result.metrics.synthesized_success)} | "
            f"{_format_metric(result.metrics.best_single_success)} | "
            f"{_format_metric(result.metrics.oracle_success)} | "
            f"{_format_metric(result.metrics.latency_s)} |"
        )
    lines.append("")
    return "\n".join(lines)


def _score_by_task(task: BenchmarkTaskRecordV1, output: str) -> float | None:
    params = task.scorer.params or {}
    if task.scorer.kind == "exact":
        return exact_match(output, _expected(params))
    if task.scorer.kind == "contains":
        return contains_expected(output, _expected(params))
    if task.scorer.kind == "custom":
        if "json_keys" in params:
            return _json_key_score(output, params["json_keys"])
        if params.get("tool_call_validity") is True:
            return _tool_call_validity(task, output)
    return None


def _expected(params: Mapping[str, Any]) -> str | None:
    expected = params.get("expected")
    return expected if isinstance(expected, str) else None


def _json_key_score(output: str, keys: Any) -> float:
    if not isinstance(keys, list):
        return 0.0
    try:
        data = json.loads(output)
    except json.JSONDecodeError:
        return 0.0
    if not isinstance(data, dict):
        return 0.0
    return float(all(isinstance(key, str) and key in data for key in keys))


def _schema_validity(task: BenchmarkTaskRecordV1, output: str) -> float:
    if task.task_id.startswith("tiny_json_"):
        try:
            json.loads(output)
        except json.JSONDecodeError:
            return 0.0
    return 1.0


def _tool_call_validity(task: BenchmarkTaskRecordV1, output: str) -> float | None:
    params = task.scorer.params or {}
    if "tool_expected" not in params and "expected_tool" not in params:
        return None
    expected_tool = params.get("expected_tool")
    if isinstance(expected_tool, str):
        return float(expected_tool.lower() in output.lower())
    if params.get("tool_expected") is False:
        return float("tool" not in output.lower() or "no tool" in output.lower())
    return None


def _optional_run_id(metadata: Mapping[str, Any]) -> str | None:
    run_id = metadata.get("run_id")
    return run_id if isinstance(run_id, str) else None


def _average_metric(results: list[TinyBenchmarkResult], field: str) -> str:
    values = [
        value
        for result in results
        if isinstance(value := getattr(result.metrics, field), int | float)
    ]
    if not values:
        return "unknown"
    return f"{sum(values) / len(values):.4f}"


def _optional_float(value: Any) -> float | None:
    return float(value) if isinstance(value, int | float) else None


def _format_metric(value: float | None) -> str:
    if value is None:
        return "-"
    return f"{value:.4f}"


__all__ = [
    "DISCLAIMER",
    "TINY_FIXTURE_ROOT",
    "TinyBenchmarkMetrics",
    "TinyBenchmarkResult",
    "TinyBenchmarkTask",
    "assert_tiny_task_matrix",
    "format_tiny_benchmark_report",
    "load_tiny_results",
    "load_tiny_tasks",
    "run_tiny_benchmark",
    "score_tiny_output",
    "write_tiny_benchmark_report",
    "write_tiny_jsonl",
]
