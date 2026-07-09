"""One implementation of the shard lifecycle.

Replaces the six copy-pasted shell runners: start SUT, invoke the benchmark's
own scaffold on exactly one instance, grade/normalize, checkpoint ShardResult,
and tear down. The result store makes the operation idempotent -- an existing
shard is returned without re-running anything.
"""

from __future__ import annotations

import time
from pathlib import Path

from hyperkit.core.contracts import BenchmarkAdapter, SystemUnderTest
from hyperkit.core.models import Cell, ShardResult, ShardStatus
from hyperkit.core.store import ResultStore
from hyperkit.telemetry import configure, record_shard, shard_span


class RunOrchestrator:
    def __init__(
        self,
        *,
        sweep_id: str,
        generation: int,
        adapter: BenchmarkAdapter,
        sut: SystemUnderTest,
        store: ResultStore,
        work_root: Path,
    ):
        self.sweep_id = sweep_id
        self.generation = generation
        self.adapter = adapter
        self.sut = sut
        self.store = store
        self.work_root = Path(work_root)
        configure()

    def run(self, cell: Cell, instance_id: str) -> ShardResult:
        shard_id = cell.shard_id(
            instance_id,
            adapter_version=self.adapter.version,
            dataset_hash=cell.dataset_hash,
        )
        existing = {r.shard_id: r for r in self.store.get_all(self.sweep_id)}
        if shard_id in existing:
            return existing[shard_id]

        workdir = self.work_root / cell.cell_id / instance_id
        workdir.mkdir(parents=True, exist_ok=True)
        started = time.monotonic()
        attributes = {
            "hyperkit.sweep.id": self.sweep_id,
            "hyperkit.generation": self.generation,
            "hyperkit.cell.id": cell.cell_id,
            "hyperkit.shard.id": shard_id,
            "hyperkit.benchmark": cell.benchmark,
            "hyperkit.instance.id": instance_id,
            "hyperkit.sut.kind": cell.sut.kind,
            "hyperkit.sut.hash": cell.sut.hash,
        }
        with shard_span(attributes):
            try:
                target = self.sut.start(cell.sut, workdir)
                raw = self.adapter.run_instance(instance_id, target, workdir)
                graded = self.adapter.grader().grade(instance_id, raw)
                resolved = bool(graded.get("resolved", False))
                status = ShardStatus.RESOLVED if resolved else ShardStatus.UNRESOLVED
                result = ShardResult(
                    shard_id=shard_id,
                    cell_id=cell.cell_id,
                    generation=self.generation,
                    benchmark=cell.benchmark,
                    instance_id=instance_id,
                    sut_hash=cell.sut.hash,
                    status=status,
                    resolved=resolved,
                    cost_usd=_float_or_none(raw.get("cost_usd")),
                    tokens=_int_or_none(raw.get("tokens")),
                    steps=_int_or_none(raw.get("steps")),
                    latency_s=time.monotonic() - started,
                    adapter_version=self.adapter.version,
                    dataset_hash=cell.dataset_hash,
                    raw={**raw, **graded},
                )
            except Exception as exc:
                result = ShardResult(
                    shard_id=shard_id,
                    cell_id=cell.cell_id,
                    generation=self.generation,
                    benchmark=cell.benchmark,
                    instance_id=instance_id,
                    sut_hash=cell.sut.hash,
                    status=ShardStatus.ERROR,
                    failure_mode=type(exc).__name__,
                    latency_s=time.monotonic() - started,
                    adapter_version=self.adapter.version,
                    dataset_hash=cell.dataset_hash,
                    raw={"error": str(exc)},
                )
            finally:
                self.sut.stop()

        self.store.put(self.sweep_id, result)
        record_shard(
            attributes,
            resolved=result.resolved,
            error=result.status == ShardStatus.ERROR,
            latency=result.latency_s or 0.0,
            cost=result.cost_usd,
        )
        return result


def _float_or_none(value: object) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float, str)):
        return float(value)
    return None


def _int_or_none(value: object) -> int | None:
    if value is None:
        return None
    if isinstance(value, (int, float, str)):
        return int(value)
    return None

