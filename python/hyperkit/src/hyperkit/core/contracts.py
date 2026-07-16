"""The pluggability seams, as typed Protocols.

Everything SUT/benchmark/grader/compute-specific enters the core through these.
The core depends only on the Protocols, never on a concrete implementation, so a
new benchmark or system under test is a plugin, not a fork.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from hyperkit.core.models import (
    BackendSubmission,
    ResourceProfile,
    ShardPlan,
    ShardResult,
    SUTTarget,
    TopologySpec,
)


@runtime_checkable
class ManifestSource(Protocol):
    """Enumerates instance ids for a benchmark and pins a dataset hash."""

    def enumerate(self) -> list[str]: ...

    @property
    def dataset_hash(self) -> str: ...


@runtime_checkable
class Grader(Protocol):
    """Turns a scaffold's raw output for one instance into a graded result."""

    def grade(self, instance_id: str, raw_output: dict[str, Any]) -> dict[str, Any]:
        """Return at least ``{"resolved": bool}``; extra keys land in ShardResult.raw."""
        ...


@runtime_checkable
class BenchmarkAdapter(Protocol):
    """Everything that varies across benchmarks, behind five methods.

    Adding a benchmark = implement these + register. ``run_instance`` executes
    the benchmark's own harness/scaffold against an opaque SUT endpoint; grading
    and parsing normalize to a ShardResult. Reading committed artifacts (the
    acceptance path) uses ``parse_report`` without running anything.

    ``params`` carries the cell's harness-side coordinates (``Cell.params`` --
    already part of cell identity): sample counts, selection policies,
    temperatures, and similar knobs that belong to the harness rather than the
    SUT. Adapters that have no harness knobs simply ignore it.
    """

    name: str
    version: str

    def manifest(self, ref: str) -> ManifestSource: ...

    def resource_profile(self) -> ResourceProfile: ...

    def run_instance(
        self,
        instance_id: str,
        target: SUTTarget,
        workdir: Path,
        params: dict[str, Any],
    ) -> dict[str, Any]: ...

    def grader(self) -> Grader: ...

    def parse_report(self, report: dict[str, Any], instances: Sequence[str]) -> dict[str, bool]:
        """Map a benchmark report to {instance_id: resolved}. Used by collect."""
        ...


@runtime_checkable
class SystemUnderTest(Protocol):
    """Renders a TopologySpec into a runnable OpenAI-compatible endpoint.

    ``solo-model`` points straight at a provider; ``fusionkit-serve`` boots a
    fusion endpoint from the spec. The core only ever holds the spec + endpoint
    string; it never imports the SUT's internals.
    """

    kind: str

    def start(self, spec: TopologySpec, workdir: Path) -> SUTTarget:
        """Start (if needed) and return the endpoint+model the harness should target."""
        ...

    def stop(self) -> None: ...


@runtime_checkable
class ComputeBackend(Protocol):
    """Where shards run. ``local`` runs in-process; ``aws-batch`` submits jobs."""

    name: str

    def submit(
        self,
        shards: Sequence[ShardPlan],
        sweep_id: str,
    ) -> BackendSubmission: ...

    def results(self, sweep_id: str) -> list[ShardResult]: ...


@runtime_checkable
class ExperimentContext(Protocol):
    """Read-only context handed to Experiment.cells()/on_results()."""

    def manifest(self, benchmark: str, ref: str) -> list[str]: ...

    def panels(self, tag: str | None = None) -> list[list[str]]: ...

    def prior_results(self) -> list[ShardResult]: ...


@runtime_checkable
class Experiment(Protocol):
    """The matrix, as code.

    ``cells`` generates the sweep's cells with arbitrary logic; ``on_results`` is
    the optional pattern-driven follow-up (evaluated at collect time, proposed for
    approval). The platform materializes whatever these yield and freezes it.
    """

    id: str

    def cells(self, ctx: ExperimentContext) -> Iterable[Cell]: ...

    def on_results(
        self, results: Sequence[ShardResult], ctx: ExperimentContext
    ) -> Iterable[Cell]: ...
