from __future__ import annotations

import io
import json
from typing import Any

from hyperkit.cloud.controller import (
    HypergridController,
    S3SweepRepository,
    _sweep_ids_from_message,
)
from hyperkit.core.models import Cell, ShardResult, ShardStatus, TopologySpec


class FakeS3:
    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], bytes] = {}

    def put_object(self, *, Bucket: str, Key: str, Body: bytes, **_: Any) -> None:
        self.objects[(Bucket, Key)] = Body

    def get_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        return {"Body": io.BytesIO(self.objects[(Bucket, Key)])}

    def list_objects_v2(self, *, Bucket: str, Prefix: str, **_: Any) -> dict[str, Any]:
        keys = [
            key
            for bucket, key in self.objects
            if bucket == Bucket and key.startswith(Prefix)
        ]
        return {"Contents": [{"Key": key} for key in sorted(keys)], "IsTruncated": False}

def _cell(kind: str, label: str) -> Cell:
    return Cell(
        sut=TopologySpec(
            kind=kind,
            params={"topology": label, "k": 1, "panel": ["a", "b"]},
        ),
        benchmark="bench",
        instances=["i1", "i2"],
        dataset_hash="data",
        label=label,
    )


def _result(cell: Cell, instance: str, resolved: bool) -> ShardResult:
    return ShardResult(
        shard_id=f"{cell.cell_id}-{instance}",
        cell_id=cell.cell_id,
        generation=0,
        benchmark="bench",
        instance_id=instance,
        sut_hash=cell.sut.hash,
        status=ShardStatus.RESOLVED if resolved else ShardStatus.UNRESOLVED,
        resolved=resolved,
        cost_usd=1.0,
        latency_s=2.0,
    )


def test_controller_recomputes_and_persists_snapshots() -> None:
    s3 = FakeS3()
    repo = S3SweepRepository("bucket", client=s3)
    solo = _cell("solo-model", "solo")
    fused = _cell("fusionkit-serve", "driver")
    for generation, cell in enumerate((solo, fused)):
        s3.put_object(
            Bucket="bucket",
            Key=f"runs/run/cells/{cell.cell_id}.json",
            Body=json.dumps(
                {"cell": cell.model_dump(mode="json"), "generation": generation}
            ).encode(),
        )
    for cell, outcomes in ((solo, [True, False]), (fused, [True, True])):
        for instance, resolved in zip(cell.instances, outcomes, strict=True):
            repo.store.put("run", _result(cell, instance, resolved))

    controller = HypergridController(repo)
    snapshots = controller.reconcile("run")
    by_label = {snapshot.label: snapshot for snapshot in snapshots}
    assert by_label["solo"].resolution_rate == 0.5
    assert by_label["driver"].resolution_rate == 1.0
    assert by_label["driver"].delta_vs_best_single == 0.5
    assert by_label["driver"].rank == 1
    assert ("run", fused.cell_id) in controller.snapshots
    assert ("bucket", f"runs/run/snapshots/{fused.cell_id}.json") in s3.objects


def test_s3_event_extracts_sweep_id() -> None:
    body = json.dumps(
        {
            "Records": [
                {
                    "s3": {
                        "object": {
                            "key": "prefix/runs/run-123/results/shard.json"
                        }
                    }
                }
            ]
        }
    )
    assert _sweep_ids_from_message(body) == {"run-123"}


def test_repository_finds_sweeps_below_a_team_prefix() -> None:
    s3 = FakeS3()
    s3.put_object(
        Bucket="bucket",
        Key="team/runs/run-123/results/shard.json",
        Body=b"{}",
    )
    repo = S3SweepRepository("bucket", prefix="team", client=s3)
    assert repo.sweep_ids() == ["run-123"]

