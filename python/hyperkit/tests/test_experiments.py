from __future__ import annotations

from pathlib import Path

import hyperkit.adapters  # noqa: F401
from hyperkit.core.contracts import ExperimentContext
from hyperkit.core.experiments import CartesianExperiment, load_experiment
from hyperkit.core.lock import load_lock
from hyperkit.core.models import Cell, ShardResult
from hyperkit.core.registry import register_backend
from hyperkit.core.sweep import SweepEngine


class Context(ExperimentContext):
    def manifest(self, benchmark: str, ref: str) -> list[str]:
        assert benchmark == "swebench_verified"
        return ["task-a", "task-b"]

    def panels(self, tag: str | None = None) -> list[list[str]]:
        return [["terminus", "qwen3"]]

    def prior_results(self) -> list[ShardResult]:
        return []


def test_cartesian_matrix_materializes_topology_as_cells() -> None:
    exp = CartesianExperiment(
        {
            "benchmarks": ["swebench_verified"],
            "instances": {"swebench_verified": "manifest.txt"},
            "sut": "fusionkit-serve",
            "axes": {
                "topology": ["driver", "rank-fuse"],
                "k": [1, 4],
            },
        }
    )
    cells = list(exp.cells(Context()))
    assert len(cells) == 4
    assert {c.params["topology"] for c in cells} == {"driver", "rank-fuse"}
    assert {c.params["k"] for c in cells} == {1, 4}
    assert all(c.instances == ["task-a", "task-b"] for c in cells)


def test_plan_and_status_use_result_store_as_resume_state(tmp_path: Path) -> None:
    matrix = tmp_path / "matrix.yaml"
    manifest = tmp_path / "manifest.txt"
    manifest.write_text("task-a\ntask-b\n")
    matrix.write_text(
        f"""
id: smoke
benchmarks: [swebench_verified]
instances:
  swebench_verified: {manifest}
sut: fusionkit-serve
axes:
  topology: [driver]
  k: [1]
"""
    )
    engine = SweepEngine(tmp_path / "run")
    engine.plan(CartesianExperiment.from_yaml(matrix))
    assert engine.status() == {"total": 2, "done": 0, "pending": 2}


def test_apply_records_exact_submitted_denominator(tmp_path: Path) -> None:
    class RecordingBackend:
        name = "recording-submissions"

        def __init__(self) -> None:
            self.shards: list[tuple[Cell, str]] = []

        def submit(self, shards, sweep_id: str) -> None:
            assert sweep_id == "smoke"
            self.shards.extend(shards)

        def results(self, sweep_id: str) -> list[ShardResult]:
            return []

    matrix = tmp_path / "matrix.yaml"
    manifest = tmp_path / "manifest.txt"
    manifest.write_text("task-a\ntask-b\n")
    matrix.write_text(
        f"""
id: smoke
benchmarks: [swebench_verified]
instances:
  swebench_verified: {manifest}
sut: fusionkit-serve
axes:
  topology: [driver]
  k: [1]
"""
    )
    backend = RecordingBackend()
    register_backend(backend)
    engine = SweepEngine(tmp_path / "run")
    engine.plan(CartesianExperiment.from_yaml(matrix), sweep_id="smoke")

    assert engine.apply(backend.name, rung=1) == 1

    lock = load_lock(engine.lock_path)
    assert len(lock.submissions) == 1
    assert lock.submissions[0].rung == 1
    assert len(lock.submissions[0].shards) == 1
    assert len(backend.shards) == 1
    (row,) = engine.collect().cells
    assert row["n_submitted"] == 1
    assert row["n_missing"] == 1
    assert row["rate"] == 0.0
    assert row["complete"] is False


def test_matrix_as_code_loads_and_materializes_once(tmp_path: Path) -> None:
    source = tmp_path / "experiment.py"
    source.write_text(
        """
from hyperkit import Cell, Experiment, TopologySpec, experiment

@experiment(id="code-grid")
class Grid(Experiment):
    def cells(self, ctx):
        yield Cell(
            sut=TopologySpec(kind="solo-model", params={"model": "m"}),
            benchmark="swebench_verified",
            instances=["task-a"],
            dataset_hash="pinned",
        )
"""
    )
    loaded = load_experiment(str(source))
    assert loaded.id == "code-grid"
    cells = list(loaded.cells(Context()))
    assert len(cells) == 1
    assert cells[0].sut.kind == "solo-model"

