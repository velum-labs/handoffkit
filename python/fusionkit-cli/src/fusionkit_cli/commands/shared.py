from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import TYPE_CHECKING

from fusionkit_core.config import FusionConfig

if TYPE_CHECKING:
    from fusionkit_core.clients import ChatClient
    from fusionkit_core.kernel import FusionKernel


def legacy_kernel(
    config: FusionConfig, clients: Mapping[str, ChatClient], run_root: Path
) -> FusionKernel:
    from fusionkit_core.artifacts import LocalArtifactStore
    from fusionkit_core.fusion import FusionEngine
    from fusionkit_core.kernel import FusionKernel
    from fusionkit_core.run import FusionRunManager
    from fusionkit_core.run_store import FileSystemRunStore

    engine = FusionEngine(config=config, clients=clients)
    manager = FusionRunManager(
        engine,
        FileSystemRunStore(run_root),
        LocalArtifactStore(run_root),
    )
    return FusionKernel(engine, manager)
