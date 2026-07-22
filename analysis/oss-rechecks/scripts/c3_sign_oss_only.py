"""OSS-only slice of the C3 public-vs-calibrated failure-dependence sign check.

Recomputes both sides from the committed calibrated outcomes CSV and the cached
public LiveCodeBench records using the committed phase0 functions, then filters
to pairs among the OSS calibrated endpoints (deepseek, kimi, qwen3).
"""

from __future__ import annotations

import csv
import importlib.util
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

ROOT = Path("/workspace")
OUT = ROOT / "analysis" / "oss-rechecks"
RESULT = OUT / "c3_sign_oss.csv"
OUTCOMES = ROOT / "analysis" / "phase0" / "c3_outcomes.csv"
OSS_ENDPOINTS = {"deepseek", "kimi", "qwen3"}

SPEC = importlib.util.spec_from_file_location(
    "c3_transfer_pilot_phase0",
    ROOT / "analysis" / "phase0" / "scripts" / "c3_transfer_pilot.py",
)
assert SPEC is not None and SPEC.loader is not None
c3 = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = c3
SPEC.loader.exec_module(c3)


def main() -> int:
    rows = c3.read_outcomes(OUTCOMES)
    by_task: dict[str, dict[str, Any]] = defaultdict(dict)
    for row in rows:
        by_task[str(row["task_id"])][str(row["endpoint_id"])] = row
    calibrated = c3.pairwise_calibrated(by_task)
    public = c3.pairwise_public()
    out_rows = []
    for pair in sorted(set(calibrated) & set(public)):
        members = {part.strip() for part in pair.split("/")}
        if not members <= OSS_ENDPOINTS:
            continue
        cal = calibrated[pair]
        pub = public[pair]
        out_rows.append(
            {
                "pair": pair,
                "public_phi": round(pub["phi"], 4) if pub["phi"] is not None else "",
                "public_sign": pub["sign"],
                "public_n": pub["n"],
                "calibrated_phi": round(cal["phi"], 4) if cal["phi"] is not None else "",
                "calibrated_sign": cal["sign"],
                "calibrated_n": cal["n"],
                "agreement": pub["sign"] == cal["sign"],
                "mapping_note": pub["mapping_note"],
            }
        )
    with RESULT.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(out_rows[0].keys()), lineterminator="\n")
        writer.writeheader()
        writer.writerows(out_rows)
    agreed = sum(1 for row in out_rows if row["agreement"])
    print(f"wrote {RESULT}")
    print(f"OSS-only sign agreement: {agreed} / {len(out_rows)}")
    for row in out_rows:
        print(
            f"  {row['pair']}: public {row['public_phi']}/{row['public_sign']} vs "
            f"calibrated {row['calibrated_phi']}/{row['calibrated_sign']} -> "
            f"{'agree' if row['agreement'] else 'DISAGREE'}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
