from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import cast

from model_area_index.core import (
    LIVE_SOURCES,
    PROFILE_AREA_WEIGHTS,
    PanelProfile,
    build_data_quality_report,
    build_model_area_matrix,
    build_task_outcome_reports,
    fetch_live_model_area_scores,
    format_model_area_matrix_markdown,
    load_model_area_scores,
    load_task_outcomes,
    recommend_panel,
    write_model_area_scores,
)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="model-area-index",
        description="Fetch public benchmark data and build a no-run model-by-area matrix.",
    )
    parser.add_argument(
        "--snapshot",
        type=Path,
        help="load an already-fetched JSON/JSONL snapshot instead of fetching live",
    )
    parser.add_argument(
        "--write-snapshot",
        type=Path,
        help="write fetched/loaded model-area rows as JSONL",
    )
    parser.add_argument(
        "--source",
        action="append",
        choices=LIVE_SOURCES,
        help="live source to fetch; repeatable; defaults to all sources",
    )
    parser.add_argument(
        "--limit-per-source",
        type=int,
        help="cap parsed rows per source for quick inspection",
    )
    parser.add_argument(
        "--fail-on-data-quality-errors",
        action="store_true",
        help="exit non-zero when validation finds data-quality errors",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="fail if any live source cannot be fetched or parsed",
    )
    parser.add_argument(
        "--task-outcome-snapshot",
        action="append",
        type=Path,
        help="JSON/JSONL TaskOutcome snapshot; repeatable; metrics stay separate from matrix",
    )
    parser.add_argument("--timeout-s", type=float, default=30.0)
    parser.add_argument("--output", "-o", type=Path, help="write rendered matrix to this path")
    parser.add_argument("--format", choices=("json", "markdown"), default="json")
    parser.add_argument(
        "--target-profile",
        choices=sorted(PROFILE_AREA_WEIGHTS),
        help="also emit a model shortlist for this profile",
    )
    args = parser.parse_args(argv)

    sources = tuple(args.source) if args.source is not None else LIVE_SOURCES
    if args.snapshot is not None:
        scores = load_model_area_scores(args.snapshot)
        source_metadata: object = {"loaded_snapshot": str(args.snapshot)}
    else:
        fetched = fetch_live_model_area_scores(
            sources=sources,
            timeout_s=args.timeout_s,
            limit_per_source=args.limit_per_source,
            strict=args.strict,
        )
        scores = fetched.scores
        source_metadata = [source.model_dump(mode="json") for source in fetched.sources]
    if args.write_snapshot is not None:
        write_model_area_scores(args.write_snapshot, scores)
    matrix = build_model_area_matrix(scores)
    data_quality_report = build_data_quality_report(scores)
    if args.fail_on_data_quality_errors and data_quality_report.error_count:
        raise SystemExit(2)
    task_outcome_metrics = []
    for task_outcome_snapshot in args.task_outcome_snapshot or []:
        task_outcome_metrics.extend(
            metric.model_dump(mode="json")
            for metric in build_task_outcome_reports(load_task_outcomes(task_outcome_snapshot))
        )
    recommendation = (
        recommend_panel(matrix, target_profile=cast(PanelProfile, args.target_profile))
        if args.target_profile is not None
        else None
    )
    if args.format == "json":
        payload: dict[str, object] = matrix.model_dump(mode="json")
        payload["source_metadata"] = source_metadata
        payload["data_quality_report"] = data_quality_report.model_dump(mode="json")
        if task_outcome_metrics:
            payload["task_outcome_metrics"] = task_outcome_metrics
        if recommendation is not None:
            payload["recommendation"] = recommendation.model_dump(mode="json")
        rendered = json.dumps(payload, indent=2)
    else:
        rendered = format_model_area_matrix_markdown(matrix)
        if recommendation is not None:
            rendered += _format_panel_recommendation_markdown(recommendation)
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    sys.stdout.write(rendered + "\n")
    return 0


def _format_panel_recommendation_markdown(recommendation: object) -> str:
    members = getattr(recommendation, "members", [])
    lines = [
        "",
        "## Recommended shortlist",
        "",
        f"Profile: {getattr(recommendation, 'target_profile', '-')}",
        "",
        "| Model | Provider | Score | Missing areas |",
        "| --- | --- | ---: | --- |",
    ]
    for member in members:
        missing = ", ".join(getattr(member, "missing_areas", [])) or "-"
        lines.append(
            f"| {getattr(member, 'model_key', '-')} | {getattr(member, 'provider', '-')} | "
            f"{getattr(member, 'score', 0.0):.3f} | {missing} |"
        )
    lines.append("")
    return "\n".join(lines)


if __name__ == "__main__":
    raise SystemExit(main())
