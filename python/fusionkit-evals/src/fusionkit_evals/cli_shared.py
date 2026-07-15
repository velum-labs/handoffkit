from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path

from fusionkit_core.artifacts import LocalArtifactStore
from fusionkit_core.clients import ChatClient
from fusionkit_core.config import FusionConfig
from fusionkit_core.fusion import FusionEngine
from fusionkit_core.kernel import FusionKernel
from fusionkit_core.run import FusionRunManager
from fusionkit_core.run_store import FileSystemRunStore


def benchmark_kernel(
    config: FusionConfig, clients: Mapping[str, ChatClient], run_root: Path
) -> FusionKernel:
    engine = FusionEngine(config=config, clients=clients)
    manager = FusionRunManager(
        engine,
        FileSystemRunStore(run_root),
        LocalArtifactStore(run_root),
    )
    return FusionKernel(engine, manager)
