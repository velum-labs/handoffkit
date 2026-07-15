"""Append-only sweep lock persistence + materialization.

The lock is the frozen record of a sweep: generations of cells, each with
provenance. ``plan`` materializes an experiment's cells into generation 0;
``extend`` appends a generation containing only genuinely new cells (dedup by
cell coordinate). Nothing here executes experiment code beyond the single
materialization pass its caller performs.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from hyperkit.core.models import Cell, Generation, SweepLock


def repo_sha(cwd: Path | None = None) -> str | None:
    probe = (cwd or Path.cwd()).resolve()
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    try:
        out = subprocess.run(
            ["git", "-C", str(probe), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
        )
        return out.stdout.strip()
    except Exception:
        return None


def load_lock(path: Path) -> SweepLock:
    return SweepLock.model_validate_json(path.read_text())


def save_lock(lock: SweepLock, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(lock.model_dump_json(indent=2))


def new_lock(
    sweep_id: str,
    cells: list[Cell],
    *,
    reason: str,
    experiment_id: str | None,
    experiment_source_hash: str | None,
    max_vcpus: int = 64,
    spend_ceiling_usd: float | None = None,
    cwd: Path | None = None,
) -> SweepLock:
    gen = Generation(
        index=0,
        reason=reason,
        cells=cells,
        experiment_id=experiment_id,
        experiment_source_hash=experiment_source_hash,
        repo_sha=repo_sha(cwd),
    )
    return SweepLock(
        sweep_id=sweep_id,
        max_vcpus=max_vcpus,
        spend_ceiling_usd=spend_ceiling_usd,
        generations=[gen],
    )


def extend_lock(
    lock: SweepLock,
    cells: list[Cell],
    *,
    reason: str,
    experiment_id: str | None,
    experiment_source_hash: str | None,
    cwd: Path | None = None,
    retire_missing: bool = False,
) -> tuple[SweepLock, list[Cell]]:
    """Append a generation of only-new cells; return (lock, newly_added_cells).

    New-ness is by cell coordinate (SUT hash + benchmark + params), so extending
    with overlapping cells is a no-op for the overlap -- the shards dedupe anyway,
    but we avoid recording redundant cells in the lock.
    """

    existing = {c.cell_id for c in lock.all_cells()}
    added = [c for c in cells if c.cell_id not in existing]
    proposed_ids = {c.cell_id for c in cells}
    retired = (
        sorted(c.cell_id for c in lock.active_cells() if c.cell_id not in proposed_ids)
        if retire_missing
        else []
    )
    if not added and not retired:
        return lock, []
    gen = Generation(
        index=lock.next_generation_index(),
        reason=reason,
        cells=added,
        retired_cell_ids=retired,
        experiment_id=experiment_id,
        experiment_source_hash=experiment_source_hash,
        repo_sha=repo_sha(cwd),
    )
    lock = lock.model_copy(update={"generations": [*lock.generations, gen]})
    return lock, added
