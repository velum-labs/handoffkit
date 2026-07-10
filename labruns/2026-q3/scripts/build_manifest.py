#!/usr/bin/env python3
"""Build the frozen Phase C algorithmic manifest from LiveCodeBench filters.

Writes:
  - labruns/2026-q3/manifest-algorithmic.json      (LCB_MANIFEST input)
  - labruns/2026-q3/manifest-algorithmic.jsonl     (audit rows)

Run once before any Phase C API calls. Requires `datasets<4` (HF loading script).

Usage:
  uv run --with 'datasets<4' python labruns/2026-q3/scripts/build_manifest.py
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

from fusionkit_evals.livecodebench_data import scan_matching_question_ids

REPO = Path(__file__).resolve().parents[3]
OUT_DIR = REPO / "labruns" / "2026-q3"
JSON_PATH = OUT_DIR / "manifest-algorithmic.json"
JSONL_PATH = OUT_DIR / "manifest-algorithmic.jsonl"


def main() -> None:
    parser = argparse.ArgumentParser(description="Build frozen Phase C LCB manifest")
    parser.add_argument("--count", type=int, default=60, help="number of tasks to pin")
    parser.add_argument("--min-date", default="2025-01-01", help="contest_date lower bound")
    parser.add_argument(
        "--difficulty",
        default="medium,hard",
        help="comma-separated difficulties",
    )
    parser.add_argument("--version", default="release_v6", help="LCB dataset version tag")
    args = parser.parse_args()
    difficulties = {d.strip().lower() for d in args.difficulty.split(",") if d.strip()}

    rows = scan_matching_question_ids(
        args.count,
        version=args.version,
        min_date=args.min_date,
        difficulties=difficulties,
    )
    if len(rows) < args.count:
        print(
            f"warning: only {len(rows)} tasks matched filters (wanted {args.count})",
            file=sys.stderr,
        )

    manifest = {
        "name": "livecodebench-2026-q3-algorithmic",
        "suite": "livecodebench",
        "version": args.version,
        "dataset": "livecodebench/code_generation_lite",
        "description": (
            "Frozen Phase C manifest for the 2026-q3 clean-room cycle. "
            "Medium/hard stdin problems on or after the preregistered cutoff."
        ),
        "contamination_window": {
            "min_contest_date": args.min_date,
        },
        "question_ids": [row["task_id"] for row in rows],
        "built_at": datetime.now(UTC).isoformat(),
        "task_count": len(rows),
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    JSON_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    with JSONL_PATH.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, sort_keys=True) + "\n")

    print(
        json.dumps(
            {
                "manifest_json": str(JSON_PATH),
                "manifest_jsonl": str(JSONL_PATH),
                "task_count": len(rows),
                "min_date": args.min_date,
                "difficulties": sorted(difficulties),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
