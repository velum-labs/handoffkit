from __future__ import annotations

import pytest
from hyperkit import telemetry
from hyperkit.core.models import (
    Cell,
    ShardResult,
    ShardStatus,
    SubmittedShard,
    TopologySpec,
)
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


def _submitted(
    results: list[ShardResult],
) -> dict[str, dict[str, SubmittedShard]]:
    expected: dict[str, dict[str, SubmittedShard]] = {}
    for result in results:
        expected.setdefault(result.cell_id, {})[result.instance_id] = SubmittedShard(
            cell_id=result.cell_id,
            instance_id=result.instance_id,
            shard_id=result.shard_id,
            generation=result.generation,
            benchmark=result.benchmark,
            sut_hash=result.sut_hash,
            adapter_version=result.adapter_version,
            dataset_hash=result.dataset_hash,
        )
    return expected


def test_snapshots_rank_delta_pareto_and_progress() -> None:
    solo = _cell("solo-model", "solo", "solo")
    fused = _cell("fusionkit-serve", "fused", "fused")
    results = [
        _result(solo, "i1", True, 0.25, 3.0),
        _result(solo, "i2", False, 0.25, 4.0),
        _result(fused, "i1", True, 1.0, 5.0),
        _result(fused, "i2", True, 1.0, 7.0),
    ]
    snapshots = build_cell_snapshots(
        "run",
        [(solo, 0), (fused, 1)],
        results,
        submitted_shards=_submitted(results),
    )
    by_label = {snapshot.label: snapshot for snapshot in snapshots}

    assert by_label["solo"].resolution_rate == 0.5
    assert by_label["solo"].planned_shards == 3
    assert by_label["solo"].submitted_shards == 2
    assert by_label["solo"].pending_shards == 0
    assert by_label["solo"].complete is True
    assert by_label["fused"].resolution_rate == 1.0
    assert by_label["fused"].delta_vs_best_single == 0.5
    assert by_label["fused"].rank == 1
    assert by_label["fused"].pareto is True
    assert by_label["solo"].pareto is True  # cheaper, lower-quality tradeoff
    assert by_label["fused"].cost_per_resolve == 1.0
    assert by_label["fused"].metric_attributes()["hyperkit.generation"] == 1
    assert by_label["fused"].metric_attributes()["run_id"] == "run"
    assert by_label["fused"].metric_attributes()["cell_id"] == fused.cell_id
    assert by_label["fused"].metric_attributes()["cell_label"] == "fused"
    assert by_label["fused"].metric_attributes()["cell_role"] == "compound"
    assert by_label["solo"].metric_attributes()["cell_role"] == "open"
    assert by_label["solo"].metric_attributes()["model"] == "solo"


def test_snapshot_resolution_rate_counts_errors_as_failures() -> None:
    solo = _cell("solo-model", "solo", "solo")
    resolved = _result(solo, "i1", True, 0.25, 3.0)
    error = ShardResult(
        shard_id=f"{solo.cell_id}-i2",
        cell_id=solo.cell_id,
        generation=0,
        benchmark="bench",
        instance_id="i2",
        sut_hash=solo.sut.hash,
        status=ShardStatus.ERROR,
    )

    (snapshot,) = build_cell_snapshots("run", [(solo, 0)], [resolved, error])

    assert snapshot.resolution_rate == pytest.approx(1 / 3)
    assert snapshot.errors == 1
    assert snapshot.missing_shards == 1
    assert snapshot.complete is False
    assert snapshot.rank == 0


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

    attributes = current[0].metric_attributes()
    assert completed.calls == [(1, attributes), (0, attributes)]
    assert resolved.calls == [(0, attributes), (0, attributes)]
    assert errors.calls == [(0, attributes), (0, attributes)]
    assert running.calls == [
        (0, attributes),
        (0, attributes),
    ]
    assert cost.calls == [(0.25, attributes), (0.0, attributes)]


def test_controller_resource_identity_is_stable_and_runner_identity_is_automatic() -> None:
    assert telemetry._resource_attributes("hyperkit-runner", None) == {
        "service.name": "hyperkit-runner"
    }
    assert telemetry._resource_attributes(
        "hyperkit-controller",
        "controller:bucket:root",
    ) == {
        "service.name": "hyperkit-controller",
        "service.instance.id": "controller:bucket:root",
    }

