"""Fusion Bench report writers (JSONL / Markdown / HTML).

Split out of :mod:`fusionkit_evals.fusion_bench` so the report-rendering concern
is separated from the runner, joining, and scoring logic. Depends on the data
models and :func:`build_fusion_bench_report` from ``fusion_bench`` (one
direction only, so there is no import cycle).
"""

from __future__ import annotations

import html
import json
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from fusionkit_evals.fusion_bench import (
    FusionBenchAttemptRow,
    FusionBenchParetoPoint,
    FusionBenchReport,
    build_fusion_bench_report,
)


def write_fusion_bench_report_jsonl(
    path: str | Path,
    report_or_rows: FusionBenchReport | Iterable[FusionBenchAttemptRow],
) -> None:
    report = _ensure_report(report_or_rows)
    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        _write_report_record(handle, "metadata", report.metadata.model_dump(mode="json"))
        _write_report_record(handle, "aggregate", report.aggregate.model_dump(mode="json"))
        for task in report.tasks:
            _write_report_record(handle, "task_metrics", task.model_dump(mode="json"))
        for correlation in report.failure_correlations:
            _write_report_record(
                handle,
                "failure_correlation",
                correlation.model_dump(mode="json"),
            )
        for point in report.quality_cost_points:
            _write_report_record(handle, "pareto_quality_cost", point.model_dump(mode="json"))
        for point in report.quality_latency_points:
            _write_report_record(handle, "pareto_quality_latency", point.model_dump(mode="json"))


def write_fusion_bench_markdown_report(
    path: str | Path,
    report_or_rows: FusionBenchReport | Iterable[FusionBenchAttemptRow],
) -> None:
    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        format_fusion_bench_markdown_report(report_or_rows),
        encoding="utf-8",
    )


def format_fusion_bench_markdown_report(
    report_or_rows: FusionBenchReport | Iterable[FusionBenchAttemptRow],
) -> str:
    report = _ensure_report(report_or_rows)
    lines = [
        "# Fusion Bench Report",
        "",
        f"Disclaimer: {report.disclaimer}.",
        "",
        "## Summary",
        "",
        f"- Tasks: {report.aggregate.total_tasks}",
        f"- Succeeded tasks: {report.aggregate.succeeded_tasks}",
        f"- Skipped tasks: {report.aggregate.skipped_tasks}",
        f"- Failed tasks: {report.aggregate.failed_tasks}",
        f"- Synthesized success: {_format_metric(report.aggregate.synthesized_success)}",
        f"- Best single success: {_format_metric(report.aggregate.best_single_success)}",
        f"- Random success: {_format_metric(report.aggregate.random_success)}",
        f"- Oracle success: {_format_metric(report.aggregate.oracle_success)}",
        f"- Judge-synthesis regret: {_format_metric(report.aggregate.judge_synthesis_regret)}",
        f"- Cost estimate: {_format_metric(report.aggregate.cost_estimate)}",
        f"- Latency: {_format_metric(report.aggregate.latency_s)}",
        f"- Tool success: {_format_metric(report.aggregate.tool_success)}",
        f"- Candidate failure rate: {_format_metric(report.aggregate.candidate_failure_rate)}",
        f"- Judge parse failures: {report.aggregate.judge_parse_failures}",
        "",
        "## Outcomes",
        "",
    ]
    for outcome, count in sorted(report.aggregate.harness_verification_outcomes.items()):
        lines.append(f"- {outcome}: {count}")
    lines.extend(
        [
            "",
            "## Failure Kinds",
            "",
        ]
    )
    for failure_kind, count in sorted(report.aggregate.failure_kinds.items()):
        lines.append(f"- {failure_kind}: {count}")
    lines.extend(
        [
            "",
            "## Task Metrics",
            "",
            "| Task | Category | Outcome | Synthesized | Best Single | Random | "
            "Oracle | Regret | Cost | Latency |",
            "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
        ]
    )
    for task in report.tasks:
        lines.append(
            "| "
            f"{task.task_id} | "
            f"{task.category} | "
            f"{task.harness_verification_outcome} | "
            f"{_format_metric(task.synthesized_success)} | "
            f"{_format_metric(task.best_single_success)} | "
            f"{_format_metric(task.random_success)} | "
            f"{_format_metric(task.oracle_success)} | "
            f"{_format_metric(task.judge_synthesis_regret)} | "
            f"{_format_metric(task.cost_estimate)} | "
            f"{_format_metric(task.latency_s)} |"
        )
    lines.extend(["", "## Pairwise Failure Correlation", ""])
    if report.failure_correlations:
        lines.extend(
            [
                "| Left | Right | N | Left Failure | Right Failure | Correlation |",
                "| --- | --- | ---: | ---: | ---: | ---: |",
            ]
        )
        for correlation in report.failure_correlations:
            lines.append(
                "| "
                f"{correlation.left_model_id} | "
                f"{correlation.right_model_id} | "
                f"{correlation.n} | "
                f"{_format_metric(correlation.left_failure_rate)} | "
                f"{_format_metric(correlation.right_failure_rate)} | "
                f"{_format_metric(correlation.correlation)} |"
            )
    else:
        lines.append("No overlapping scored candidate failures.")
    lines.extend(["", "## Pareto Plot Data", ""])
    lines.extend(_format_pareto_table("Quality vs Cost", report.quality_cost_points))
    lines.append("")
    lines.extend(_format_pareto_table("Quality vs Latency", report.quality_latency_points))
    lines.extend(
        [
            "",
            "## Reproducibility",
            "",
            f"- Schema bundle hashes: {', '.join(report.metadata.schema_bundle_hashes) or '-'}",
            f"- Repo SHAs: {', '.join(report.metadata.repo_shas) or '-'}",
            f"- Config IDs: {', '.join(report.metadata.config_ids) or '-'}",
            f"- Modes: {', '.join(report.metadata.modes) or '-'}",
            f"- Runtime platform: {report.metadata.runtime_platform}",
            f"- Python version: {report.metadata.python_version}",
            "",
        ]
    )
    return "\n".join(lines)


def write_fusion_bench_html_report(
    path: str | Path,
    report_or_rows: FusionBenchReport | Iterable[FusionBenchAttemptRow],
) -> None:
    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        format_fusion_bench_html_report(report_or_rows),
        encoding="utf-8",
    )


def format_fusion_bench_html_report(
    report_or_rows: FusionBenchReport | Iterable[FusionBenchAttemptRow],
) -> str:
    markdown = format_fusion_bench_markdown_report(report_or_rows)
    body = "\n".join(f"<pre>{html.escape(markdown)}</pre>".splitlines())
    return (
        "<!doctype html>\n"
        '<html lang="en">\n'
        "<head>\n"
        '<meta charset="utf-8">\n'
        "<title>Fusion Bench Report</title>\n"
        "</head>\n"
        "<body>\n"
        f"{body}\n"
        "</body>\n"
        "</html>\n"
    )


def _ensure_report(
    report_or_rows: FusionBenchReport | Iterable[FusionBenchAttemptRow],
) -> FusionBenchReport:
    if isinstance(report_or_rows, FusionBenchReport):
        return report_or_rows
    return build_fusion_bench_report(report_or_rows)


def _write_report_record(handle: Any, record_type: str, payload: dict[str, Any]) -> None:
    handle.write(json.dumps({"record_type": record_type, **payload}) + "\n")


def _format_pareto_table(title: str, points: list[FusionBenchParetoPoint]) -> list[str]:
    lines = [
        f"### {title}",
        "",
    ]
    if not points:
        lines.append("No scored points with this axis available.")
        return lines
    lines.extend(
        [
            "| ID | Quality | Cost | Latency |",
            "| --- | ---: | ---: | ---: |",
        ]
    )
    for point in points:
        lines.append(
            "| "
            f"{point.id} | "
            f"{_format_metric(point.quality)} | "
            f"{_format_metric(point.cost_estimate)} | "
            f"{_format_metric(point.latency_s)} |"
        )
    return lines


def _format_metric(value: float | None) -> str:
    if value is None:
        return "-"
    return f"{value:.4f}"
