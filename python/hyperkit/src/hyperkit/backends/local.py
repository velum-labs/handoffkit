"""Local compute backend: executes shards through RunOrchestrator.

The AWS Batch backend implements the same ComputeBackend contract; local
is the development/reproduction backend and proves the platform is not shaped
around the cloud. ``max_workers > 1`` runs network-bound shards on a thread
pool -- the ShardResult store is per-file and idempotent, and each shard gets
its own orchestrator (and therefore its own SUT instance), so workers never
share mutable state.
"""

from __future__ import annotations

import os
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor

from hyperkit.core.models import BackendSubmission, Cell, ShardPlan, ShardResult
from hyperkit.core.orchestrator import RunOrchestrator


class LocalComputeBackend:
    name = "local"

    def __init__(
        self,
        orchestrator_for: Callable[[Cell], RunOrchestrator],
        *,
        max_workers: int = 1,
    ):
        self._orchestrator_for = orchestrator_for
        self._results: dict[str, list[ShardResult]] = {}
        self.max_workers = max(1, int(max_workers))

    def submit(
        self,
        shards: Sequence[ShardPlan],
        sweep_id: str,
    ) -> BackendSubmission:
        out = self._results.setdefault(sweep_id, [])
        if self.max_workers == 1:
            for shard in shards:
                out.append(
                    self._orchestrator_for(shard.cell).run(
                        shard.cell,
                        shard.instance_id,
                    )
                )
            return BackendSubmission(
                accepted_shard_ids=[shard.shard_id for shard in shards],
                image_digest="local",
            )
        with ThreadPoolExecutor(max_workers=self.max_workers) as pool:
            futures = [
                pool.submit(
                    self._orchestrator_for(shard.cell).run,
                    shard.cell,
                    shard.instance_id,
                )
                for shard in shards
            ]
            for future in futures:
                out.append(future.result())
        return BackendSubmission(
            accepted_shard_ids=[shard.shard_id for shard in shards],
            image_digest="local",
        )

    def results(self, sweep_id: str) -> list[ShardResult]:
        return list(self._results.get(sweep_id, []))


def default_max_workers() -> int:
    return int(os.environ.get("HYPERKIT_LOCAL_MAX_WORKERS", "1"))
