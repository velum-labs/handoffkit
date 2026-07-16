"""Local hypergrid controller: filesystem twin of the S3/SQS cloud controller.

Reads sweep locks + ShardResult checkpoints from local ``--workdir``
directories (the ``SweepEngine`` layout: ``sweep.lock.json`` + ``results/``),
recomputes the same derived ``CellSnapshot``s the cloud controller produces,
and publishes them as OTLP observable gauges so the production Grafana
dashboards work unchanged against a local Prometheus OTLP receiver.

Stateless and resumable: every tick rebuilds snapshots from the durable
files, so restarting the controller (or the sweep) needs no repair.
"""

from __future__ import annotations

import hashlib
import json
import signal
import time
from pathlib import Path

from hyperkit.core.lock import load_lock
from hyperkit.core.snapshots import CellSnapshot, build_cell_snapshots
from hyperkit.core.store import ResultStore
from hyperkit.telemetry import configure, set_cell_snapshots

_stop = False


def _stop_handler(_signum: int, _frame: object) -> None:
    global _stop
    _stop = True


def snapshot_workdir(workdir: Path) -> list[CellSnapshot]:
    """Build snapshots for one sweep workdir; empty when no lock exists yet."""

    lock_path = workdir / "sweep.lock.json"
    if not lock_path.exists():
        return []
    lock = load_lock(lock_path)
    active = {cell.cell_id for cell in lock.active_cells()}
    cells = [
        (cell, generation.index)
        for generation in lock.generations
        for cell in generation.cells
        if cell.cell_id in active
    ]
    results = ResultStore(workdir / "results").get_all(lock.sweep_id)
    submitted = lock.submitted_instances()
    return build_cell_snapshots(
        lock.sweep_id,
        cells,
        results,
        submitted_instances=submitted or None,
    )


def write_snapshots(workdir: Path, snapshots: list[CellSnapshot]) -> None:
    """Persist derived snapshots next to the sweep for offline inspection."""

    out = workdir / "snapshots"
    out.mkdir(parents=True, exist_ok=True)
    for snapshot in snapshots:
        (out / f"{snapshot.cell_id}.json").write_text(snapshot.model_dump_json(indent=2))
    index = [
        {"cell_id": s.cell_id, "label": s.label, "resolution_rate": s.resolution_rate}
        for s in snapshots
    ]
    (out / "index.json").write_text(json.dumps(index, indent=2))


def run_local_controller(
    workdirs: list[Path],
    *,
    poll_interval: float = 10.0,
    once: bool = False,
) -> int:
    identity_payload = "\0".join(sorted(str(workdir.resolve()) for workdir in workdirs))
    identity = hashlib.sha256(identity_payload.encode()).hexdigest()[:16]
    configure(
        "hyperkit-controller",
        service_instance_id=f"hyperkit-local-controller:{identity}",
    )
    signal.signal(signal.SIGTERM, _stop_handler)
    signal.signal(signal.SIGINT, _stop_handler)
    while not _stop:
        combined: list[CellSnapshot] = []
        for workdir in workdirs:
            snapshots = snapshot_workdir(workdir)
            if snapshots:
                write_snapshots(workdir, snapshots)
                combined.extend(snapshots)
        set_cell_snapshots(combined)
        if once:
            break
        time.sleep(poll_interval)
    return 0
