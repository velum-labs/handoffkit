"""hyperkit: SUT-agnostic experiment orchestration platform.

Public surface re-exports the core contracts, models, and the sweep engine.
Nothing here imports a system-under-test implementation; SUTs and benchmark
adapters register themselves via entry-points (see hyperkit.core.registry).
"""

from __future__ import annotations

from hyperkit.core.contracts import (
    BenchmarkAdapter,
    ComputeBackend,
    ExperimentContext,
    Grader,
    ManifestSource,
    SystemUnderTest,
)
from hyperkit.core.experiments import (
    CartesianExperiment,
    Experiment,
    experiment,
    load_experiment,
)
from hyperkit.core.models import (
    Cell,
    Generation,
    ResourceProfile,
    RunResult,
    ShardResult,
    ShardStatus,
    SUTTarget,
    SweepLock,
    TopologySpec,
)
from hyperkit.core.sweep import SweepEngine

__all__ = [
    "BenchmarkAdapter",
    "Cell",
    "ComputeBackend",
    "Experiment",
    "ExperimentContext",
    "CartesianExperiment",
    "experiment",
    "Generation",
    "Grader",
    "ManifestSource",
    "ResourceProfile",
    "RunResult",
    "ShardResult",
    "ShardStatus",
    "SweepEngine",
    "SweepLock",
    "SystemUnderTest",
    "SUTTarget",
    "TopologySpec",
    "load_experiment",
]
