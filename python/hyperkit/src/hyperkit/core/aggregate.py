"""Aggregate ShardResults into per-cell tables (the ``collect`` output).

Recompute-from-artifacts discipline: metrics come only from stored ShardResults,
never from run-time stdout. Solo cells (single-model SUTs) contribute to a
per-benchmark oracle so fused cells can be scored against best-member/headroom.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from hyperkit.core.models import Cell, RunResult, ShardResult, ShardStatus, SubmittedShard
from hyperkit.stats import wilson_interval


def _is_solo(cell: Cell) -> bool:
    return (
        cell.sut.kind in {"solo-model", "solo"}
        and int(cell.params.get("n_samples", 1)) == 1
        and cell.params.get("selection", "first") == "first"
    )


def validate_submitted_result(
    result: ShardResult,
    expected: SubmittedShard,
) -> None:
    mismatches: list[str] = []
    expected_fields = {
        "shard_id": expected.shard_id,
        "cell_id": expected.cell_id,
        "instance_id": expected.instance_id,
        "generation": expected.generation,
        "benchmark": expected.benchmark,
        "sut_hash": expected.sut_hash,
        "adapter_version": expected.adapter_version,
        "dataset_hash": expected.dataset_hash,
        "source_sha": expected.source_sha,
        "image_digest": expected.image_digest,
    }
    for field, value in expected_fields.items():
        if getattr(result, field) != value:
            mismatches.append(
                f"{field}={getattr(result, field)!r} (expected {value!r})"
            )
    terminal = {
        ShardStatus.RESOLVED,
        ShardStatus.UNRESOLVED,
        ShardStatus.ERROR,
    }
    if result.status not in terminal:
        mismatches.append(f"status={result.status!r} is not terminal")
    if result.resolved != (result.status == ShardStatus.RESOLVED):
        mismatches.append(
            f"resolved={result.resolved!r} is inconsistent with status={result.status!r}"
        )
    if mismatches:
        raise ValueError(
            f"result {result.shard_id} does not match its submitted shard: "
            + "; ".join(mismatches)
        )


def aggregate(
    sweep_id: str,
    cells: Sequence[Cell],
    results: Sequence[ShardResult],
    *,
    submitted_shards: Mapping[str, Mapping[str, SubmittedShard]] | None = None,
) -> RunResult:
    by_cell: dict[str, list[ShardResult]] = {}
    known_cell_ids = {cell.cell_id for cell in cells}
    seen: set[tuple[str, str]] = set()
    for r in results:
        if r.cell_id not in known_cell_ids:
            raise ValueError(f"result references unknown cell {r.cell_id}")
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
        expected_by_instance = (
            submitted_shards.get(cell.cell_id, {})
            if submitted_shards is not None
            else {}
        )
        expected = (
            set(expected_by_instance)
            if submitted_shards is not None
            else set(cell.instances)
        )
        unexpected = {shard.instance_id for shard in shards} - expected
        if unexpected:
            raise ValueError(
                f"results outside the declared cohort for cell {cell.cell_id}: "
                f"{sorted(unexpected)}"
            )
        if submitted_shards is not None:
            for shard in shards:
                validate_submitted_result(
                    shard,
                    expected_by_instance[shard.instance_id],
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
        n = len(expected)
        resolved = sum(1 for shard in completed if shard.resolved)
        errors = sum(1 for shard in completed if shard.status.value == "error")
        ci = wilson_interval(resolved, n) if n else None
        completed_rate = resolved / len(graded) if graded else None
        terminal_instances = {shard.instance_id for shard in completed}
        missing = expected - terminal_instances
        row: dict[str, Any] = {
            "cell_id": cell.cell_id,
            "label": cell.label,
            "benchmark": cell.benchmark,
            "sut": cell.sut.kind,
            "sut_hash": cell.sut.hash,
            "params": cell.params,
            # The primary rate is intent-to-treat over the declared submitted
            # cohort. Errors and missing checkpoints are failures, never
            # silently removed from the denominator.
            "n_graded": n,
            "n_terminal": len(completed),
            "n_completed": len(graded),
            "n_errors": errors,
            "n_present": len(shards),
            "n_submitted": len(expected),
            "n_missing": len(missing),
            "n_instances": len(cell.instances),
            "resolved": resolved,
            "rate": (resolved / n) if n else None,
            "completed_rate": completed_rate,
            "complete": bool(expected) and not missing,
            "cohort_source": (
                "submission_ledger"
                if submitted_shards is not None
                else "planned_fallback"
            ),
            "wilson_low": ci.low if ci else None,
            "wilson_high": ci.high if ci else None,
        }
        if not _is_solo(cell):
            oracle = solo_solved.get(cell.benchmark)
            if oracle is not None and n:
                best = len(oracle & expected)
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
