"""Deterministic per-generation analysis for the hypergrid hill-climb.

The supervising agent runs this after every `hyperkit collect`; it owns the
arithmetic (rates, intervals, paired tests, gap attribution, prune/broaden
flags) while the agent owns the judgment. Zero API calls.

Usage:
  uv run python analysis/hypergrid/supervisor.py --workdir .hyperkit/gen0
  uv run python analysis/hypergrid/supervisor.py --workdir .hyperkit/gen0 --json out.json
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from hyperkit.core.lock import load_lock
from hyperkit.core.store import ResultStore
from hyperkit.stats import wilson_interval

ANCHOR_PREFIX = "anchor-"


def mcnemar(b: int, c: int) -> float:
    """Two-sided exact McNemar p-value on discordant pairs."""

    n = b + c
    if n == 0:
        return 1.0
    total = sum(math.comb(n, k) for k in range(0, min(b, c) + 1)) * 2
    return min(1.0, total / (2**n))


def load(workdir: Path) -> tuple[Any, list[Any], dict[str, dict[str, Any]]]:
    lock = load_lock(workdir / "sweep.lock.json")
    results = ResultStore(workdir / "results").get_all(lock.sweep_id)
    cells = {}
    for generation in lock.generations:
        for cell in generation.cells:
            cells[cell.cell_id] = {"cell": cell, "generation": generation.index}
    active = {c.cell_id for c in lock.active_cells()}
    cells = {cid: v for cid, v in cells.items() if cid in active}
    return lock, results, cells


def analyze(workdir: Path) -> dict[str, Any]:
    lock, results, cells = load(workdir)
    submitted_instances = lock.submitted_instances()
    cohort_verified = bool(lock.submissions)
    by_cell: dict[str, dict[str, Any]] = defaultdict(dict)  # cell -> instance -> result
    for result in results:
        if result.instance_id in by_cell[result.cell_id]:
            raise ValueError(
                f"duplicate results for cell {result.cell_id} instance {result.instance_id}"
            )
        by_cell[result.cell_id][result.instance_id] = result

    rows: list[dict[str, Any]] = []
    for cell_id, meta in cells.items():
        cell = meta["cell"]
        shard_map = by_cell.get(cell_id, {})
        expected = (
            submitted_instances.get(cell_id, set())
            if cohort_verified
            else set(cell.instances)
        )
        unexpected = set(shard_map) - expected
        if unexpected:
            raise ValueError(
                f"results outside the declared cohort for cell {cell_id}: "
                f"{sorted(unexpected)}"
            )
        terminal = {
            inst: result
            for inst, result in shard_map.items()
            if inst in expected
            and result.status.value in ("resolved", "unresolved", "error")
        }
        completed = {
            inst: result
            for inst, result in terminal.items()
            if result.status.value in ("resolved", "unresolved")
        }
        errors = sum(1 for result in terminal.values() if result.status.value == "error")
        missing = expected - set(terminal)
        n = len(expected)
        resolved = sum(1 for result in terminal.values() if result.resolved)
        ci = wilson_interval(resolved, n) if n else None
        cost = sum(r.cost_usd or 0.0 for r in shard_map.values())
        oracle = sum(
            1 for result in terminal.values() if (result.raw or {}).get("oracle_private")
        )
        rows.append(
            {
                "cell_id": cell_id,
                "label": cell.label or cell_id,
                "generation": meta["generation"],
                "sut": cell.sut.kind,
                "params": cell.params,
                "n": n,
                "completed": len(completed),
                "errors": errors,
                "submitted": len(expected),
                "missing": len(missing),
                "complete": bool(expected) and not missing,
                "cohort_verified": cohort_verified,
                "decision_eligible": (
                    cohort_verified
                    and bool(expected)
                    and not missing
                    and len({result.adapter_version for result in terminal.values()}) == 1
                ),
                "resolved": resolved,
                "rate": resolved / n if n else None,
                "completed_rate": resolved / len(completed) if completed else None,
                "lo": ci.low if ci else None,
                "hi": ci.high if ci else None,
                "cost": cost,
                "oracle_private": oracle,
                "adapter_versions": sorted(
                    {result.adapter_version for result in terminal.values()}
                ),
                "pass_vector": {
                    inst: bool(terminal[inst].resolved) if inst in terminal else False
                    for inst in expected
                },
            }
        )

    anchors = [
        r
        for r in rows
        if r["label"].startswith(ANCHOR_PREFIX) and r["decision_eligible"]
    ]
    opens = [
        r
        for r in rows
        if not r["label"].startswith(ANCHOR_PREFIX) and r["decision_eligible"]
    ]
    best_anchor = max(anchors, key=lambda r: r["rate"], default=None)
    solo_opens = [r for r in opens if r["sut"] == "solo-model"]
    best_solo = max(solo_opens, key=lambda r: r["rate"], default=None)

    # Paired comparisons on shared instances.
    def paired(a: dict[str, Any], b: dict[str, Any]) -> dict[str, Any]:
        shared = set(a["pass_vector"]) & set(b["pass_vector"])
        b_only = sum(1 for i in shared if a["pass_vector"][i] and not b["pass_vector"][i])
        c_only = sum(1 for i in shared if b["pass_vector"][i] and not a["pass_vector"][i])
        a_resolved = sum(1 for i in shared if a["pass_vector"][i])
        b_resolved = sum(1 for i in shared if b["pass_vector"][i])
        return {
            "n_shared": len(shared),
            "a_only": b_only,
            "b_only": c_only,
            "a_rate": a_resolved / len(shared) if shared else None,
            "b_rate": b_resolved / len(shared) if shared else None,
            "delta": (a_resolved - b_resolved) / len(shared) if shared else None,
            "p": mcnemar(b_only, c_only),
        }

    for row in rows:
        if best_anchor and row is not best_anchor and row["decision_eligible"]:
            cmp = paired(row, best_anchor)
            row["vs_anchor"] = {
                "gap": cmp["delta"],
                **cmp,
            }
        if best_solo and row is not best_solo and row["decision_eligible"]:
            cmp = paired(row, best_solo)
            row["vs_best_solo"] = {
                **cmp,
            }

    # Prune flags: Wilson-dominated by best solo open.
    for row in rows:
        row["flags"] = []
        if (
            best_solo
            and row["decision_eligible"]
            and row is not best_solo
            and row["hi"] is not None
            and row["hi"] < (best_solo["lo"] or 0)
        ):
            row["flags"].append("PRUNE:wilson-dominated-by-best-solo")
        if row["errors"] > max(2, 0.1 * max(row["n"], 1)):
            row["flags"].append("FORENSICS:high-error-count")
        if not row["cohort_verified"]:
            row["flags"].append("BLOCK:unverified-submission-cohort")
        if row["missing"]:
            row["flags"].append("BLOCK:missing-submitted-shards")
        if len(row["adapter_versions"]) > 1:
            row["flags"].append("FORENSICS:mixed-adapter-versions")

    # Complementarity: union coverage of top pairs among solo opens.
    pairs = []
    for i, a in enumerate(solo_opens):
        for b in solo_opens[i + 1 :]:
            shared = set(a["pass_vector"]) & set(b["pass_vector"])
            if not shared:
                continue
            union = sum(
                1 for inst in shared if a["pass_vector"][inst] or b["pass_vector"][inst]
            )
            a_wins = sum(
                1 for inst in shared if a["pass_vector"][inst] and not b["pass_vector"][inst]
            )
            b_wins = sum(
                1 for inst in shared if b["pass_vector"][inst] and not a["pass_vector"][inst]
            )
            union_ci = wilson_interval(union, len(shared))
            pairs.append(
                {
                    "pair": [a["label"], b["label"]],
                    "n": len(shared),
                    "union_rate": union / len(shared),
                    "union_low": union_ci.low,
                    "union_high": union_ci.high,
                    "a_rate": sum(1 for i2 in shared if a["pass_vector"][i2]) / len(shared),
                    "b_rate": sum(1 for i2 in shared if b["pass_vector"][i2]) / len(shared),
                    "a_only": a_wins,
                    "b_only": b_wins,
                }
            )
    pairs.sort(key=lambda p: -p["union_rate"])

    return {
        "sweep_id": lock.sweep_id,
        "rows": sorted(rows, key=lambda r: -(r["rate"] or -1)),
        "best_anchor": best_anchor["label"] if best_anchor else None,
        "best_solo_open": best_solo["label"] if best_solo else None,
        "top_pairs": pairs[:10],
        "total_cost": sum(r["cost"] for r in rows),
    }


def print_report(report: dict[str, Any]) -> None:
    print(f"sweep {report['sweep_id']}  spend=${report['total_cost']:.2f}")
    print(f"best anchor: {report['best_anchor']}   best solo open: {report['best_solo_open']}")
    print()
    header = (
        f"{'label':<34}{'n':>5}{'err':>4}{'rate':>8}{'wilson':>14}"
        f"{'gapSOTA':>9}{'pSOTA':>7}{'dSolo':>7}{'oracle':>7}{'cost$':>8}  flags"
    )
    print(header)
    for row in report["rows"]:
        if not row["n"]:
            continue
        wilson = f"[{row['lo']:.0%},{row['hi']:.0%}]"
        gap = row.get("vs_anchor", {}).get("gap")
        p_anchor = row.get("vs_anchor", {}).get("p")
        d_solo = row.get("vs_best_solo", {}).get("delta")
        oracle = row["oracle_private"] or ""
        print(
            f"{row['label']:<34}{row['n']:>5}{row['errors']:>4}{row['rate']:>8.1%}{wilson:>14}"
            f"{(f'{gap:+.1%}' if gap is not None else '-'):>9}"
            f"{(f'{p_anchor:.3f}' if p_anchor is not None else '-'):>7}"
            f"{(f'{d_solo:+.1%}' if d_solo is not None else '-'):>7}"
            f"{oracle!s:>7}{row['cost']:>8.2f}  {','.join(row['flags'])}"
        )
    print()
    print("top complementary pairs (union coverage on shared instances):")
    for pair in report["top_pairs"][:6]:
        print(
            f"  {pair['pair'][0]} + {pair['pair'][1]}: union {pair['union_rate']:.1%} "
            f"[{pair['union_low']:.1%}, {pair['union_high']:.1%}] "
            f"(solo {pair['a_rate']:.1%} / {pair['b_rate']:.1%}, "
            f"unique {pair['a_only']}/{pair['b_only']}, n={pair['n']})"
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workdir", type=Path, default=Path(".hyperkit/gen0"))
    parser.add_argument("--json", type=Path, default=None)
    args = parser.parse_args()
    report = analyze(args.workdir)
    print_report(report)
    if args.json:
        slim = {
            **report,
            "rows": [{k: v for k, v in r.items() if k != "pass_vector"} for r in report["rows"]],
        }
        args.json.write_text(json.dumps(slim, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
