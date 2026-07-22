"""OSS-only rerun of the C2 and C2V selection-value tests.

Reuses the committed phase0 analysis functions unmodified; the only change is
that each source universe is filtered to the systems classified `is_oss=True`
in the committed OSS-scan classification CSV.
"""

from __future__ import annotations

import csv
import sys
from pathlib import Path
from typing import Any

ROOT = Path("/workspace")
sys.path.insert(0, str(ROOT / "analysis" / "phase0" / "scripts"))
sys.path.insert(0, str(ROOT / "analysis" / "oss-scan" / "scripts"))

import analyze_c1_c2 as c1c2  # noqa: E402
import analyze_c2_vselection as c2v  # noqa: E402
import oss_scan  # noqa: E402

OUT = ROOT / "analysis" / "oss-rechecks"
CLASSIFICATION = ROOT / "analysis" / "oss-scan" / "oss_classification.csv"
C2_RESULTS = OUT / "c2_oss_results.csv"
C2V_RESULTS = OUT / "c2v_oss_results.csv"


def oss_ids_by_source() -> dict[str, set[str]]:
    out: dict[str, set[str]] = {}
    with CLASSIFICATION.open(encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            if row["is_oss"] == "True":
                out.setdefault(row["source_id"], set()).add(row["system_id"])
    return out


def filter_matrix(data: Any, keep: set[str]) -> Any:
    return oss_scan.MatrixData(
        source_id=data.source_id,
        title=f"{data.title} (OSS-only)",
        tier_label=data.tier_label,
        y={system: rows for system, rows in data.y.items() if system in keep},
        clusters=data.clusters,
        systems={system: info for system, info in data.systems.items() if system in keep},
        notes=list(data.notes) + ["Universe filtered to is_oss=True systems."],
        floor_relaxed=data.floor_relaxed,
    )


def flatten_c2(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "source_id": row["source_id"],
            "k": row["k"],
            "n_systems": row["n_systems"],
            "heldout_tasks": row["heldout_tasks"],
            "comp_panel": " | ".join(row["comp_panel_names"]),
            "baseline_panel": " | ".join(row["baseline_panel_names"]),
            "panels_identical": set(row["comp_panel"]) == set(row["baseline_panel"]),
            "delta_oracle": round(row["delta_oracle"], 6),
            "delta_oracle_ci_low": round(row["delta_oracle_ci_low"], 6),
            "delta_oracle_ci_high": round(row["delta_oracle_ci_high"], 6),
            "status": row["status"],
        }
        for row in rows
    ]


def flatten_c2v(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "source_id": row["source_id"],
            "k": row["k"],
            "n_systems": row["n_systems"],
            "heldout_tasks": row["heldout_tasks"],
            "v_panel": " | ".join(row["v_panel_names"]),
            "baseline_panel": " | ".join(row["baseline_panel_names"]),
            "panels_identical": row["panels_identical"],
            "heldout_delta_v": round(row["heldout_delta_v"], 6),
            "heldout_delta_v_ci_low": round(row["heldout_delta_v_ci_low"], 6),
            "heldout_delta_v_ci_high": round(row["heldout_delta_v_ci_high"], 6),
            "capture_sensitivity": row["capture_sensitivity"],
            "status": row["status"],
        }
        for row in rows
    ]


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()), lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def main() -> int:
    oss_ids = oss_ids_by_source()
    domains = oss_scan.build_domains()
    c2_rows: list[dict[str, Any]] = []
    c2v_rows: list[dict[str, Any]] = []
    skipped: list[str] = []
    for domain in domains:
        data = domain.data
        keep = oss_ids.get(data.source_id, set()) & set(data.y)
        if len(keep) < 3:
            skipped.append(f"{data.source_id} ({len(keep)} OSS systems)")
            continue
        filtered = filter_matrix(data, keep)
        for row in c1c2.c2_for_data(filtered):
            row["n_systems"] = len(keep)
            c2_rows.append(row)
        for row in c2v.analyze_data(filtered):
            row["n_systems"] = len(keep)
            c2v_rows.append(row)
    write_csv(C2_RESULTS, flatten_c2(c2_rows))
    write_csv(C2V_RESULTS, flatten_c2v(c2v_rows))
    print(f"skipped: {skipped}")
    print(f"wrote {C2_RESULTS} ({len(c2_rows)} rows)")
    print(f"wrote {C2V_RESULTS} ({len(c2v_rows)} rows)")
    c2_pass = [r for r in c2_rows if r["delta_oracle_ci_low"] > 0]
    c2v_pass = [r for r in c2v_rows if r["heldout_delta_v_ci_low"] > 0]
    print(f"C2 OSS-only wins: {len(c2_pass)} / {len(c2_rows)}")
    print(f"C2V OSS-only wins: {len(c2v_pass)} / {len(c2v_rows)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
