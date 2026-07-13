from __future__ import annotations

import pytest
from hyperkit import telemetry
from hyperkit.core.models import Cell, ShardResult, ShardStatus, TopologySpec
from hyperkit.core.snapshots import build_cell_snapshots


def _cell(kind: str, model: str, label: str) -> Cell:
    return Cell(
        sut=TopologySpec(
            kind=kind,
            params={
                "model": model,
                "topology": "driver" if kind != "solo-model" else "solo",
                "k": 1,
                "panel": ["a", "b"],
                "judge": "a",
                "commit": "write",
            },
        ),
        benchmark="bench",
        instances=["i1", "i2", "i3"],
        dataset_hash="data",
        label=label,
    )


def _result(cell: Cell, instance: str, resolved: bool, cost: float, latency: float):
    return ShardResult(
        shard_id=f"{cell.cell_id}-{instance}",
        cell_id=cell.cell_id,
        generation=0,
        benchmark="bench",
        instance_id=instance,
        sut_hash=cell.sut.hash,
        status=ShardStatus.RESOLVED if resolved else ShardStatus.UNRESOLVED,
        resolved=resolved,
        cost_usd=cost,
        latency_s=latency,
    )


def test_snapshots_rank_delta_pareto_and_progress() -> None:
    solo = _cell("solo-model", "solo", "solo")
    fused = _cell("fusionkit-serve", "fused", "fused")
    results = [
        _result(solo, "i1", True, 0.25, 3.0),
        _result(solo, "i2", False, 0.25, 4.0),
        _result(fused, "i1", True, 1.0, 5.0),
        _result(fused, "i2", True, 1.0, 7.0),
    ]
    snapshots = build_cell_snapshots("run", [(solo, 0), (fused, 1)], results)
    by_label = {snapshot.label: snapshot for snapshot in snapshots}

    assert by_label["solo"].resolution_rate == 0.5
    assert by_label["solo"].pending_shards == 1
    assert by_label["fused"].resolution_rate == 1.0
    assert by_label["fused"].delta_vs_best_single == 0.5
    assert by_label["fused"].rank == 1
    assert by_label["fused"].pareto is True
    assert by_label["solo"].pareto is True  # cheaper, lower-quality tradeoff
    assert by_label["fused"].cost_per_resolve == 1.0
    assert by_label["fused"].metric_attributes()["hyperkit.generation"] == 1
    assert by_label["fused"].metric_attributes()["run_id"] == "run"
    assert by_label["fused"].metric_attributes()["cell_id"] == fused.cell_id


class _Recorder:
    def __init__(self) -> None:
        self.calls: list[tuple[float, dict]] = []

    def add(self, value: float, attributes: dict) -> None:
        self.calls.append((value, attributes))


def test_snapshot_deltas_reconstruct_new_runner_counters(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    solo = _cell("solo-model", "solo", "solo")
    first = _result(solo, "i1", True, 0.25, 3.0)
    second = _result(solo, "i2", False, 0.25, 4.0)
    previous = build_cell_snapshots("run", [(solo, 0)], [first])
    current = build_cell_snapshots("run", [(solo, 0)], [first, second])
    completed = _Recorder()
    resolved = _Recorder()
    errors = _Recorder()
    running = _Recorder()
    cost = _Recorder()
    monkeypatch.setattr(telemetry, "_completed", completed)
    monkeypatch.setattr(telemetry, "_resolved", resolved)
    monkeypatch.setattr(telemetry, "_errors", errors)
    monkeypatch.setattr(telemetry, "_running", running)
    monkeypatch.setattr(telemetry, "_cost", cost)

    telemetry.record_snapshot_deltas(previous, current)
    telemetry.record_snapshot_deltas(current, current)

    assert completed.calls == [(1, current[0].metric_attributes())]
    assert resolved.calls == []
    assert errors.calls == []
    assert running.calls == [
        (0, current[0].metric_attributes()),
        (0, current[0].metric_attributes()),
    ]
    assert cost.calls == [(0.25, current[0].metric_attributes())]

