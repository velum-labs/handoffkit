"""The sweep engine: plan / status / resume / collect, backend-agnostic.

Ties the lock (frozen cells), the result store (checkpoint), the benchmark
adapters (for dataset hash + report parsing), and a compute backend together.
The engine never runs experiment code except in ``plan``/``extend`` where it
materializes cells once.
"""

from __future__ import annotations

import inspect
from collections.abc import Sequence
from dataclasses import dataclass
from fnmatch import fnmatch
from pathlib import Path

from hyperkit.core import registry
from hyperkit.core.aggregate import aggregate
from hyperkit.core.contracts import Experiment, ExperimentContext
from hyperkit.core.ids import hash_obj
from hyperkit.core.lock import extend_lock, load_lock, new_lock, save_lock
from hyperkit.core.models import Cell, RunResult, ShardResult
from hyperkit.core.store import ResultStore


@dataclass
class Shard:
    cell: Cell
    instance_id: str
    shard_id: str
    generation: int


class _Context(ExperimentContext):
    """Concrete ExperimentContext backed by the registry + result store."""

    def __init__(self, store: ResultStore, sweep_id: str):
        self._store = store
        self._sweep_id = sweep_id

    def manifest(self, benchmark: str, ref: str) -> list[str]:
        adapter = registry.get_benchmark(benchmark)
        return adapter.manifest(ref).enumerate()

    def panels(self, tag: str | None = None) -> list[list[str]]:
        return []

    def prior_results(self) -> list[ShardResult]:
        return self._store.get_all(self._sweep_id)


def _experiment_source_hash(experiment: Experiment) -> str | None:
    try:
        src = inspect.getsource(type(experiment))
        return hash_obj({"src": src}, length=16)
    except (OSError, TypeError):
        return None


class SweepEngine:
    """Orchestrates a sweep over a pluggable compute backend."""

    def __init__(self, workdir: Path, *, backend: str = "local"):
        self.workdir = Path(workdir)
        self.lock_path = self.workdir / "sweep.lock.json"
        self.store = ResultStore(self.workdir / "results")
        self.backend_name = backend

    # --- planning -----------------------------------------------------------

    def plan(
        self,
        experiment: Experiment,
        *,
        sweep_id: str | None = None,
        max_vcpus: int = 64,
        spend_ceiling_usd: float | None = None,
    ) -> RunResult:
        if self.lock_path.exists():
            raise FileExistsError(
                f"sweep lock already exists at {self.lock_path}; use extend or resume --frozen"
            )
        sweep_id = sweep_id or experiment.id
        ctx = _Context(self.store, sweep_id)
        cells = list(experiment.cells(ctx))
        lock = new_lock(
            sweep_id,
            cells,
            reason="plan",
            experiment_id=experiment.id,
            experiment_source_hash=_experiment_source_hash(experiment),
            max_vcpus=max_vcpus,
            spend_ceiling_usd=spend_ceiling_usd,
            cwd=self.workdir,
        )
        save_lock(lock, self.lock_path)
        shards = self._shards(cells, generation=0)
        return RunResult(
            sweep_id=sweep_id,
            cells=[{"cells": len(cells), "shards": len(shards)}],
        )

    def extend(self, experiment: Experiment, *, from_results: bool = False) -> list[Cell]:
        lock = load_lock(self.lock_path)
        ctx = _Context(self.store, lock.sweep_id)
        proposed = (
            list(experiment.on_results(self.store.get_all(lock.sweep_id), ctx))
            if from_results
            else list(experiment.cells(ctx))
        )
        before_generations = len(lock.generations)
        lock, added = extend_lock(
            lock,
            proposed,
            reason="on_results" if from_results else "extend",
            experiment_id=experiment.id,
            experiment_source_hash=_experiment_source_hash(experiment),
            cwd=self.workdir,
            retire_missing=not from_results,
        )
        if len(lock.generations) != before_generations:
            save_lock(lock, self.lock_path)
        return added

    # --- shard math ---------------------------------------------------------

    def _shards(self, cells: Sequence[Cell], *, generation: int) -> list[Shard]:
        shards: list[Shard] = []
        for cell in cells:
            adapter = registry.get_benchmark(cell.benchmark)
            for instance_id in cell.instances:
                sid = cell.shard_id(
                    instance_id,
                    adapter_version=adapter.version,
                    dataset_hash=cell.dataset_hash,
                )
                shards.append(Shard(cell, instance_id, sid, generation))
        return shards

    def all_shards(self) -> list[Shard]:
        lock = load_lock(self.lock_path)
        out: list[Shard] = []
        active = {cell.cell_id for cell in lock.active_cells()}
        for gen in lock.generations:
            out.extend(
                self._shards(
                    [cell for cell in gen.cells if cell.cell_id in active],
                    generation=gen.index,
                )
            )
        return out

    def pending_shards(self) -> list[Shard]:
        lock = load_lock(self.lock_path)
        present = self.store.present_ids(lock.sweep_id)
        return [s for s in self.all_shards() if s.shard_id not in present]

    def apply(
        self,
        backend_name: str | None = None,
        *,
        rung: int | None = None,
        only: str | None = None,
    ) -> int:
        """Submit only missing shards to a compute backend (resume-safe).

        ``rung`` limits each cell to its first N instances (successive-halving
        budgets: promote a survivor by re-applying with a larger rung; already
        completed shards dedupe via the store). ``only`` is a glob over cell
        labels so different cell families can run at different rungs.
        """

        lock = load_lock(self.lock_path)
        resolved_name = backend_name or self.backend_name
        if resolved_name == "local":
            backend = self._local_backend()
        else:
            backend = registry.get_backend(resolved_name)
        pending = self.pending_shards()
        if only is not None:
            pending = [s for s in pending if fnmatch(s.cell.label or s.cell.cell_id, only)]
        if rung is not None:
            pending = [
                s for s in pending if s.cell.instances.index(s.instance_id) < rung
            ]
        backend.submit([(s.cell, s.instance_id) for s in pending], lock.sweep_id)
        return len(pending)

    def _local_backend(self):
        """In-process backend bound to this engine's store and lock state.

        Imported lazily to keep core -> backends acyclic at module load.
        """

        from hyperkit.backends.local import LocalComputeBackend, default_max_workers
        from hyperkit.core.orchestrator import RunOrchestrator

        lock = load_lock(self.lock_path)
        generation_of = {
            cell.cell_id: gen.index for gen in lock.generations for cell in gen.cells
        }

        def orchestrator_for(cell: Cell) -> RunOrchestrator:
            # Fresh SUT instance per shard: stateful SUTs (fusionkit-serve holds
            # a subprocess handle) must not be shared across worker threads.
            sut = type(registry.get_sut(cell.sut.kind))()
            return RunOrchestrator(
                sweep_id=lock.sweep_id,
                generation=generation_of.get(cell.cell_id, 0),
                adapter=registry.get_benchmark(cell.benchmark),
                sut=sut,
                store=self.store,
                work_root=self.workdir / "work",
            )

        return LocalComputeBackend(orchestrator_for, max_workers=default_max_workers())

    # --- status / collect ---------------------------------------------------

    def status(self) -> dict[str, int]:
        total = self.all_shards()
        pending = self.pending_shards()
        return {"total": len(total), "done": len(total) - len(pending), "pending": len(pending)}

    def collect(self) -> RunResult:
        lock = load_lock(self.lock_path)
        results = self.store.get_all(lock.sweep_id)
        return aggregate(lock.sweep_id, lock.active_cells(), results)
