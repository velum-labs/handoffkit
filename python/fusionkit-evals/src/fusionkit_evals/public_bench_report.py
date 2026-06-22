"""Comparison report: fusion vs published leaderboard baselines.

Leads with the question "could fusion win at all?" - the oracle ceiling and
headroom derived from the panel members' published per-model scores, plus the
failure correlation measured from the run's per-candidate task results - before
showing the fusion score and cost next to the published baselines. A run that was
never executed (no adapter / missing credentials) still produces a useful report:
the headroom section alone says whether the panel even has room for fusion to help.
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from pathlib import Path

from pydantic import BaseModel, Field

from fusionkit_evals.bench_stats import wilson_interval
from fusionkit_evals.benchmark_panel import BenchmarkPanel
from fusionkit_evals.public_bench import (
    PUBLIC_BENCH_DISCLAIMER,
    PUBLIC_BENCHMARK_INFO,
    ExternalBenchmarkRun,
    baselines_for,
    best_baseline,
    panel_headroom_for_suite,
)

LEADERBOARD_CONTEXT_NOTE = (
    "published leaderboard numbers are CONTEXT ONLY - they use a different harness "
    "version, model set, and (here) a different task subset, so they are not a "
    "like-for-like comparison; trust the within-run metrics above"
)


class ComparisonBaselineRow(BaseModel):
    model: str
    score: float
    cost_per_run_usd: float | None = None
    delta_vs_fusion: float | None = None
    contamination_controlled: bool = False
    harness: str | None = None
    as_of: str


class FailureCorrelationRow(BaseModel):
    left_model_id: str
    right_model_id: str
    n: int
    correlation: float | None = None


class BenchmarkComparison(BaseModel):
    suite: str
    display_name: str
    mount_mode: str
    availability: str
    panel_id: str
    fusion_score: float | None = None
    fusion_ci_low: float | None = None
    fusion_ci_high: float | None = None
    fusion_cost_per_task_usd: float | None = None
    resolved_tasks: int = 0
    total_tasks: int = 0
    passed_tasks: int = 0
    model_failed_tasks: int = 0
    infra_error_tasks: int = 0
    excluded_tasks: int = 0
    best_baseline_model: str | None = None
    best_baseline_score: float | None = None
    uplift_vs_best_baseline: float | None = None
    best_single_model: str | None = None
    best_single_score: float | None = None
    oracle_ceiling: float | None = None
    oracle_headroom: float | None = None
    lopsided: bool = False
    headroom_note: str = ""
    panel_member_scores: dict[str, float] = Field(default_factory=dict)
    measured_oracle: float | None = None
    measured_regret: float | None = None
    failure_correlations: list[FailureCorrelationRow] = Field(default_factory=list)
    baselines: list[ComparisonBaselineRow] = Field(default_factory=list)
    unavailable_reason: str | None = None
    disclaimer: str = PUBLIC_BENCH_DISCLAIMER


def build_benchmark_comparison(
    run: ExternalBenchmarkRun,
    panel: BenchmarkPanel,
) -> BenchmarkComparison:
    info = PUBLIC_BENCHMARK_INFO[run.suite]
    headroom = panel_headroom_for_suite(panel, run.suite)
    top_baseline = best_baseline(run.suite)
    fusion_score = run.score if run.availability == "ran" else None
    uplift = (
        fusion_score - top_baseline.score
        if fusion_score is not None and top_baseline is not None
        else None
    )
    measured_oracle, measured_regret = _measured_oracle_regret(run)
    ci_low: float | None = None
    ci_high: float | None = None
    if run.availability == "ran" and run.resolved_tasks > 0:
        interval = wilson_interval(run.passed_tasks, run.resolved_tasks)
        ci_low, ci_high = interval.low, interval.high
    return BenchmarkComparison(
        suite=run.suite,
        display_name=info.display_name,
        mount_mode=run.mount_mode,
        availability=run.availability,
        panel_id=panel.panel_id,
        fusion_score=fusion_score,
        fusion_ci_low=ci_low,
        fusion_ci_high=ci_high,
        fusion_cost_per_task_usd=run.cost_per_task_usd if run.availability == "ran" else None,
        resolved_tasks=run.resolved_tasks,
        total_tasks=run.total_tasks,
        passed_tasks=run.passed_tasks,
        model_failed_tasks=run.model_failed_tasks,
        infra_error_tasks=run.infra_error_tasks,
        excluded_tasks=run.excluded_tasks,
        best_baseline_model=top_baseline.model if top_baseline else None,
        best_baseline_score=top_baseline.score if top_baseline else None,
        uplift_vs_best_baseline=uplift,
        best_single_model=headroom.best_single_model,
        best_single_score=headroom.best_single_score,
        oracle_ceiling=headroom.oracle_ceiling,
        oracle_headroom=headroom.oracle_headroom,
        lopsided=headroom.lopsided,
        headroom_note=headroom.note,
        panel_member_scores=headroom.member_scores,
        measured_oracle=measured_oracle,
        measured_regret=measured_regret,
        failure_correlations=_failure_correlations(run),
        baselines=[
            ComparisonBaselineRow(
                model=baseline.model,
                score=baseline.score,
                cost_per_run_usd=baseline.cost_per_run_usd,
                delta_vs_fusion=(
                    fusion_score - baseline.score if fusion_score is not None else None
                ),
                contamination_controlled=baseline.contamination_controlled,
                harness=baseline.harness,
                as_of=baseline.as_of,
            )
            for baseline in baselines_for(run.suite)
        ],
        unavailable_reason=run.unavailable_reason,
    )


def format_benchmark_comparison_markdown(comparison: BenchmarkComparison) -> str:
    lines = [
        f"# Public Benchmark Comparison: {comparison.display_name}",
        "",
        f"Disclaimer: {comparison.disclaimer}.",
        "",
        "## Could fusion win at all?",
        "",
        f"- Panel: {comparison.panel_id} (mount mode: {comparison.mount_mode})",
        f"- Best single member: {comparison.best_single_model or '-'} "
        f"({_fmt(comparison.best_single_score)})",
        f"- Oracle ceiling (independent failures): {_fmt(comparison.oracle_ceiling)}",
        f"- Oracle headroom over best single: {_fmt(comparison.oracle_headroom)}",
        f"- Lopsided panel: {'yes' if comparison.lopsided else 'no'}",
        f"- {comparison.headroom_note}",
        "",
    ]
    if comparison.failure_correlations:
        lines.extend(
            [
                "### Measured failure correlation (lower = more diverse, more headroom)",
                "",
                "| Left | Right | N | Correlation |",
                "| --- | --- | ---: | ---: |",
            ]
        )
        for row in comparison.failure_correlations:
            lines.append(
                f"| {row.left_model_id} | {row.right_model_id} | {row.n} | "
                f"{_fmt(row.correlation)} |"
            )
        lines.append("")
    lines.extend(
        [
            "## Fusion result",
            "",
            f"- Availability: {comparison.availability}",
        ]
    )
    if comparison.availability == "ran":
        lines.extend(
            [
                f"- Fusion score: {_fmt(comparison.fusion_score)} "
                f"({comparison.passed_tasks}/{comparison.resolved_tasks} scored tasks)",
                f"- 95% CI (Wilson): [{_fmt(comparison.fusion_ci_low)}, "
                f"{_fmt(comparison.fusion_ci_high)}]",
                f"- Best single member (within run): {comparison.best_single_model or '-'}",
                f"- Measured oracle (this run): {_fmt(comparison.measured_oracle)}",
                f"- Measured judge regret (oracle - fusion): {_fmt(comparison.measured_regret)}",
                f"- Fusion cost per task: {_fmt_cost(comparison.fusion_cost_per_task_usd)}",
                f"- Task accounting: scored={comparison.resolved_tasks} "
                f"model_failed={comparison.model_failed_tasks} "
                f"infra_error={comparison.infra_error_tasks} "
                f"excluded={comparison.excluded_tasks}",
            ]
        )
    else:
        lines.append(f"- Not run: {comparison.unavailable_reason or 'unavailable'}")
    lines.extend(
        [
            "",
            "## Published leaderboard (context only)",
            "",
            f"_{LEADERBOARD_CONTEXT_NOTE}._",
            "",
            "| Model | Score | Cost/run | Delta vs fusion | Contam-controlled | As of |",
            "| --- | ---: | ---: | ---: | :--: | --- |",
        ]
    )
    for baseline in comparison.baselines:
        lines.append(
            f"| {baseline.model} | {_fmt(baseline.score)} | "
            f"{_fmt_cost(baseline.cost_per_run_usd)} | {_fmt(baseline.delta_vs_fusion)} | "
            f"{'yes' if baseline.contamination_controlled else 'no'} | {baseline.as_of} |"
        )
    lines.append("")
    return "\n".join(lines)


def write_benchmark_comparison_markdown(path: str | Path, comparison: BenchmarkComparison) -> None:
    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(format_benchmark_comparison_markdown(comparison), encoding="utf-8")


def _measured_oracle_regret(run: ExternalBenchmarkRun) -> tuple[float | None, float | None]:
    if run.availability != "ran" or not run.tasks:
        return None, None
    oracle_scores: list[float] = []
    synth_scores: list[float] = []
    for row in run.tasks:
        synth = _row_score(row)
        if synth is None:
            continue
        synth_scores.append(synth)
        oracle_scores.append(max([synth, *row.candidate_scores.values()]))
    if not synth_scores:
        return None, None
    measured_oracle = sum(oracle_scores) / len(oracle_scores)
    measured_synth = sum(synth_scores) / len(synth_scores)
    return measured_oracle, measured_oracle - measured_synth


def _failure_correlations(run: ExternalBenchmarkRun) -> list[FailureCorrelationRow]:
    failures: dict[str, list[float]] = {}
    for row in run.tasks:
        for model_id, score in row.candidate_scores.items():
            failures.setdefault(model_id, []).append(1.0 if score < 1.0 else 0.0)
    model_ids = sorted(failures)
    correlations: list[FailureCorrelationRow] = []
    for left_index, left_id in enumerate(model_ids):
        for right_id in model_ids[left_index + 1 :]:
            left_values = failures[left_id]
            right_values = failures[right_id]
            paired = min(len(left_values), len(right_values))
            if paired < 2:
                continue
            correlations.append(
                FailureCorrelationRow(
                    left_model_id=left_id,
                    right_model_id=right_id,
                    n=paired,
                    correlation=_pearson(left_values[:paired], right_values[:paired]),
                )
            )
    return correlations


def _pearson(left_values: list[float], right_values: list[float]) -> float | None:
    if len(left_values) < 2:
        return None
    left_mean = sum(left_values) / len(left_values)
    right_mean = sum(right_values) / len(right_values)
    numerator = sum(
        (left - left_mean) * (right - right_mean)
        for left, right in zip(left_values, right_values, strict=True)
    )
    left_denom = math.sqrt(sum((left - left_mean) ** 2 for left in left_values))
    right_denom = math.sqrt(sum((right - right_mean) ** 2 for right in right_values))
    if left_denom == 0 or right_denom == 0:
        return None
    return numerator / (left_denom * right_denom)


def _row_score(row: object) -> float | None:
    score = getattr(row, "score", None)
    if isinstance(score, int | float):
        return float(score)
    passed = getattr(row, "passed", None)
    if isinstance(passed, bool):
        return 1.0 if passed else 0.0
    return None


def format_comparisons_markdown(comparisons: Iterable[BenchmarkComparison]) -> str:
    return "\n\n".join(
        format_benchmark_comparison_markdown(comparison) for comparison in comparisons
    )


def _fmt(value: float | None) -> str:
    if value is None:
        return "-"
    return f"{value:.4f}"


def _fmt_cost(value: float | None) -> str:
    if value is None:
        return "-"
    return f"${value:.2f}"


__all__ = [
    "BenchmarkComparison",
    "ComparisonBaselineRow",
    "FailureCorrelationRow",
    "build_benchmark_comparison",
    "format_benchmark_comparison_markdown",
    "format_comparisons_markdown",
    "write_benchmark_comparison_markdown",
]
