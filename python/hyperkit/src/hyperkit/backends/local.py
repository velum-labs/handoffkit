"""Local compute backend: executes shards synchronously through RunOrchestrator.

The AWS Batch backend implements the same ComputeBackend contract later; local
is the development/reproduction backend and proves the platform is not shaped
around the cloud.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence

from hyperkit.core.models import Cell, ShardResult
from hyperkit.core.orchestrator import RunOrchestrator


class LocalComputeBackend:
    name = "local"

    def __init__(self, orchestrator_for: Callable[[Cell], RunOrchestrator]):
        self._orchestrator_for = orchestrator_for
        self._results: dict[str, list[ShardResult]] = {}

    def submit(self, shards: Sequence[tuple[Cell, str]], sweep_id: str) -> None:
        out = self._results.setdefault(sweep_id, [])
        for cell, instance_id in shards:
            out.append(self._orchestrator_for(cell).run(cell, instance_id))

    def results(self, sweep_id: str) -> list[ShardResult]:
        return list(self._results.get(sweep_id, []))

