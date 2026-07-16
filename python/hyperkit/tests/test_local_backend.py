from __future__ import annotations

import threading
from typing import cast

from hyperkit.backends.local import LocalComputeBackend
from hyperkit.core.models import Cell, ShardPlan, ShardResult, ShardStatus, TopologySpec
from hyperkit.core.orchestrator import RunOrchestrator


class _FakeOrchestrator:
    def __init__(self, seen: set[str], lock: threading.Lock):
        self._seen = seen
        self._lock = lock

    def run(self, cell: Cell, instance_id: str) -> ShardResult:
        with self._lock:
            self._seen.add(instance_id)
        return ShardResult(
            shard_id=f"s-{instance_id}",
            cell_id=cell.cell_id,
            generation=0,
            benchmark=cell.benchmark,
            instance_id=instance_id,
            sut_hash=cell.sut.hash,
            status=ShardStatus.RESOLVED,
            resolved=True,
            adapter_version="1",
            dataset_hash=cell.dataset_hash,
        )


def _cell() -> Cell:
    return Cell(
        sut=TopologySpec(kind="fake"),
        benchmark="fake",
        instances=[f"i{n}" for n in range(20)],
        dataset_hash="d",
    )


def _plans(cell: Cell) -> list[ShardPlan]:
    return [
        ShardPlan(
            cell=cell,
            instance_id=instance_id,
            shard_id=f"s-{instance_id}",
            generation=0,
            adapter_version="1",
        )
        for instance_id in cell.instances
    ]


def test_parallel_backend_runs_every_shard_once() -> None:
    seen: set[str] = set()
    lock = threading.Lock()
    backend = LocalComputeBackend(
        lambda cell: cast(RunOrchestrator, _FakeOrchestrator(seen, lock)), max_workers=8
    )
    cell = _cell()
    acknowledgement = backend.submit(_plans(cell), "sweep")
    results = backend.results("sweep")
    assert len(results) == 20
    assert seen == set(cell.instances)
    assert {r.instance_id for r in results} == set(cell.instances)
    assert len(acknowledgement.accepted_shard_ids) == 20


def test_sequential_backend_matches_parallel() -> None:
    seen: set[str] = set()
    lock = threading.Lock()
    backend = LocalComputeBackend(
        lambda cell: cast(RunOrchestrator, _FakeOrchestrator(seen, lock)), max_workers=1
    )
    cell = _cell()
    backend.submit(_plans(cell), "sweep")
    assert len(backend.results("sweep")) == 20
