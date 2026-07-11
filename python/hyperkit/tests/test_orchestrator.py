from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from hyperkit.core.models import Cell, ResourceProfile, SUTTarget, TopologySpec
from hyperkit.core.orchestrator import RunOrchestrator
from hyperkit.core.store import ResultStore


class Grader:
    def grade(self, instance_id: str, raw_output: dict[str, Any]) -> dict[str, Any]:
        return {"resolved": raw_output["answer"] == "ok"}


class Adapter:
    name = "fake"
    version = "1"

    def manifest(self, ref: str):  # pragma: no cover - not used by orchestrator
        raise NotImplementedError

    def resource_profile(self) -> ResourceProfile:
        return ResourceProfile(needs_docker=False)

    def run_instance(self, instance_id: str, target: SUTTarget, workdir: Path):
        assert target.base_url == "http://fake/v1"
        return {"answer": "ok", "tokens": 12, "cost_usd": 0.01}

    def grader(self) -> Grader:
        return Grader()

    def parse_report(self, report, instances):  # pragma: no cover
        return {}


class Sut:
    kind = "fake"

    def __init__(self):
        self.starts = 0
        self.stops = 0

    def start(self, spec: TopologySpec, workdir: Path) -> SUTTarget:
        self.starts += 1
        return SUTTarget(base_url="http://fake/v1", model="fake")

    def stop(self) -> None:
        self.stops += 1


def test_orchestrator_is_idempotent_and_checkpoints(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    for name in (
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
        "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    ):
        monkeypatch.delenv(name, raising=False)
    store = ResultStore(tmp_path / "results")
    sut = Sut()
    orchestrator = RunOrchestrator(
        sweep_id="sweep",
        generation=0,
        adapter=Adapter(),
        sut=sut,
        store=store,
        work_root=tmp_path / "work",
    )
    cell = Cell(
        sut=TopologySpec(kind="fake"),
        benchmark="fake",
        instances=["i"],
        dataset_hash="data",
    )
    first = orchestrator.run(cell, "i")
    second = orchestrator.run(cell, "i")
    assert first.resolved is True
    assert first.tokens == 12
    assert second == first
    assert sut.starts == 1
    assert sut.stops == 1

