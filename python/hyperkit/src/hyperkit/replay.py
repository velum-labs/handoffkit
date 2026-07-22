"""Replay committed benchmark reports into a sweep, with no execution.

This is both the migration/acceptance path (reproduce an old arm's tables from
the harness reports already in git) and a general offline-aggregation tool. It
builds the same Cells/Shards/ShardResults the live pipeline would, so ``collect``
produces identical output whether the results came from a live run or a replay.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from hyperkit.core import registry
from hyperkit.core.aggregate import aggregate
from hyperkit.core.lock import new_lock, save_lock
from hyperkit.core.models import Cell, RunResult, ShardResult, ShardStatus, TopologySpec
from hyperkit.core.store import ResultStore


@dataclass
class ReplayRow:
    label: str
    sut: TopologySpec
    report_path: Path


def replay_reports(
    workdir: Path,
    *,
    sweep_id: str,
    benchmark: str,
    manifest_ref: str,
    rows: list[ReplayRow],
) -> RunResult:
    """Ingest committed reports for one benchmark into a fresh sweep at ``workdir``."""

    adapter = registry.get_benchmark(benchmark)
    manifest = adapter.manifest(manifest_ref)
    instances = manifest.enumerate()
    dataset_hash = manifest.dataset_hash

    cells: list[Cell] = []
    for row in rows:
        cells.append(
            Cell(
                sut=row.sut,
                benchmark=benchmark,
                instances=instances,
                manifest_ref=manifest_ref,
                dataset_hash=dataset_hash,
                params=row.sut.params,
                label=row.label,
            )
        )

    lock = new_lock(
        sweep_id,
        cells,
        reason="replay",
        experiment_id="replay",
        experiment_source_hash=None,
        cwd=workdir,
    )
    save_lock(lock, Path(workdir) / "sweep.lock.json")
    store = ResultStore(Path(workdir) / "results")

    for cell, row in zip(cells, rows, strict=True):
        report = json.loads(Path(row.report_path).read_text())
        outcomes = adapter.parse_report(report, cell.instances)
        submitted = set(report.get("submitted_ids", []))
        for instance_id in cell.instances:
            resolved = outcomes.get(instance_id, False)
            if instance_id in submitted or instance_id in outcomes:
                status = ShardStatus.RESOLVED if resolved else ShardStatus.UNRESOLVED
            else:
                status = ShardStatus.ERROR
            shard_id = cell.shard_id(
                instance_id, adapter_version=adapter.version, dataset_hash=dataset_hash
            )
            store.put(
                sweep_id,
                ShardResult(
                    shard_id=shard_id,
                    cell_id=cell.cell_id,
                    generation=0,
                    benchmark=benchmark,
                    instance_id=instance_id,
                    sut_hash=cell.sut.hash,
                    status=status,
                    resolved=resolved,
                    adapter_version=adapter.version,
                    dataset_hash=dataset_hash,
                ),
            )

    return aggregate(sweep_id, cells, store.get_all(sweep_id))
