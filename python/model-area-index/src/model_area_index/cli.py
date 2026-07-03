from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import cast

from model_area_index.core import (
    PROFILE_AREA_WEIGHTS,
    PanelProfile,
    build_model_area_matrix,
    format_model_area_matrix_markdown,
    load_default_model_area_scores,
    load_model_area_scores,
    recommend_panel,
)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="model-area-index",
        description="Build a no-run model-by-area capability matrix from public snapshots.",
    )
    parser.add_argument("--snapshot", type=Path, help="JSON/JSONL public model-area snapshot")
    parser.add_argument("--output", "-o", type=Path, help="write rendered matrix to this path")
    parser.add_argument("--format", choices=("json", "markdown"), default="json")
    parser.add_argument(
        "--target-profile",
        choices=sorted(PROFILE_AREA_WEIGHTS),
        help="also emit a model shortlist for this profile",
    )
    args = parser.parse_args(argv)

    scores = (
        load_model_area_scores(args.snapshot)
        if args.snapshot is not None
        else load_default_model_area_scores()
    )
    matrix = build_model_area_matrix(scores)
    recommendation = (
        recommend_panel(matrix, target_profile=cast(PanelProfile, args.target_profile))
        if args.target_profile is not None
        else None
    )
    if args.format == "json":
        payload: dict[str, object] = matrix.model_dump(mode="json")
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
