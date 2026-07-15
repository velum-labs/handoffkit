"""Aggregate ShardResults into per-cell tables (the ``collect`` output).

Recompute-from-artifacts discipline: metrics come only from stored ShardResults,
never from run-time stdout. Solo cells (single-model SUTs) contribute to a
per-benchmark oracle so fused cells can be scored against best-member/headroom.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from hyperkit.core.models import Cell, RunResult, ShardResult
from hyperkit.stats import wilson_interval


def _is_solo(cell: Cell) -> bool:
    return cell.sut.kind in {"solo-model", "solo"}


def aggregate(
    sweep_id: str,
    cells: Sequence[Cell],
    results: Sequence[ShardResult],
    *,
    submitted_instances: dict[str, set[str]] | None = None,
) -> RunResult:
    by_cell: dict[str, list[ShardResult]] = {}
    seen: set[tuple[str, str]] = set()
    for r in results:
        key = (r.cell_id, r.instance_id)
        if key in seen:
            raise ValueError(
                f"duplicate results for cell {r.cell_id} instance {r.instance_id}"
            )
        seen.add(key)
        by_cell.setdefault(r.cell_id, []).append(r)

    # Per-benchmark solo oracle: instances solved by any solo cell.
    solo_solved: dict[str, set[str]] = {}
    for cell in cells:
        if not _is_solo(cell):
            continue
        solved = solo_solved.setdefault(cell.benchmark, set())
        for r in by_cell.get(cell.cell_id, []):
            if r.resolved:
                solved.add(r.instance_id)

    rows: list[dict[str, Any]] = []
    for cell in cells:
        shards = by_cell.get(cell.cell_id, [])
        expected = (
            submitted_instances.get(cell.cell_id, set())
            if submitted_instances is not None
            else set(cell.instances)
        )
        completed = [
            shard
            for shard in shards
            if shard.status.value in {"resolved", "unresolved", "error"}
        ]
        graded = [
            shard
            for shard in completed
            if shard.status.value in {"resolved", "unresolved"}
        ]
        n = len(completed)
        resolved = sum(1 for shard in completed if shard.resolved)
        errors = sum(1 for shard in completed if shard.status.value == "error")
        ci = wilson_interval(resolved, n) if n else None
        completed_rate = resolved / len(graded) if graded else None
        row: dict[str, Any] = {
            "cell_id": cell.cell_id,
            "label": cell.label,
            "benchmark": cell.benchmark,
            "sut": cell.sut.kind,
            "sut_hash": cell.sut.hash,
            "params": cell.params,
            # Benchmark rates are intent-to-treat over every durable terminal
            # attempt. Provider/infrastructure errors are failures, never
            # silently removed from the denominator.
            "n_graded": n,
            "n_completed": len(graded),
            "n_errors": errors,
            "n_present": len(shards),
            "n_submitted": len(expected),
            "n_missing": len(expected - {shard.instance_id for shard in shards}),
            "n_instances": len(cell.instances),
            "resolved": resolved,
            "rate": (resolved / n) if n else None,
            "completed_rate": completed_rate,
            "wilson_low": ci.low if ci else None,
            "wilson_high": ci.high if ci else None,
        }
        if not _is_solo(cell):
            oracle = solo_solved.get(cell.benchmark)
            if oracle is not None and n:
                best = len(oracle & {s.instance_id for s in completed})
                row["oracle"] = best
                row["headroom"] = best - resolved
        rows.append(row)

    rows.sort(key=lambda r: (r["benchmark"], -(r["rate"] or -1)))
    return RunResult(sweep_id=sweep_id, cells=rows)


def format_table(run: RunResult) -> str:
    lines = [f"sweep {run.sweep_id}", ""]
    header = f"{'cell':<40}{'resolved':>12}{'rate':>8}  wilson95"
    lines.append(header)
    for row in run.cells:
        label = (row["label"] or row["cell_id"])[:39]
        if row["n_graded"]:
            frac = f"{row['resolved']}/{row['n_graded']}"
            rate = f"{row['rate']:.1%}"
            ci = f"[{row['wilson_low']:.0%}, {row['wilson_high']:.0%}]"
        else:
            frac, rate, ci = "-", "-", "(no graded shards)"
        lines.append(f"{label:<40}{frac:>12}{rate:>8}  {ci}")
    return "\n".join(lines)
