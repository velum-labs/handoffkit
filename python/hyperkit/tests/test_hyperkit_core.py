from __future__ import annotations

import json
from pathlib import Path

import hyperkit.adapters  # noqa: F401
import pytest
from hyperkit.core.aggregate import aggregate
from hyperkit.core.ids import canonical_json, hash_ids, hash_obj
from hyperkit.core.lock import extend_lock, load_lock, new_lock, repo_sha, save_lock
from hyperkit.core.models import (
    Cell,
    ResourceProfile,
    ShardResult,
    ShardStatus,
    SubmittedShard,
    TopologySpec,
)
from hyperkit.core.store import ResultStore
from hyperkit.core.sweep import _materialize_adapter_resource


def cell(label: str = "driver") -> Cell:
    ids = ["a", "b"]
    return Cell(
        sut=TopologySpec(kind="fusionkit-serve", params={"workflow": label, "k": 1}),
        benchmark="swebench_verified",
        instances=ids,
        manifest_ref="manifest.txt",
        dataset_hash=hash_ids(ids),
        label=label,
    )


def test_content_addresses_are_canonical_and_reload_stable() -> None:
    assert canonical_json({"b": 2, "a": 1}) == '{"a":1,"b":2}'
    assert hash_obj({"a": 1, "b": 2}) == hash_obj({"b": 2, "a": 1})
    c1, c2 = cell(), cell()
    assert c1.cell_id == c2.cell_id
    assert c1.shard_id("a", adapter_version="1", dataset_hash=c1.dataset_hash) == c2.shard_id(
        "a", adapter_version="1", dataset_hash=c2.dataset_hash
    )


def test_repo_sha_uses_nearest_existing_parent() -> None:
    repo = Path(__file__).resolve().parents[3]

    assert repo_sha(repo / "not-created" / "work")


def test_adapter_resource_profile_is_materialized_unless_explicit() -> None:
    default_cell = Cell(
        sut=TopologySpec(kind="solo-model"),
        benchmark="livecodebench",
        instances=["a"],
    )
    explicit_resource = ResourceProfile(vcpu=4.0, memory_gb=8.0)
    explicit_cell = default_cell.model_copy(update={"resource": explicit_resource})

    materialized = _materialize_adapter_resource(default_cell)

    assert materialized.resource.vcpu == 2.0
    assert materialized.resource.memory_gb == 4.0
    assert _materialize_adapter_resource(explicit_cell).resource == explicit_resource


def test_lock_is_append_only_and_extend_dedupes(tmp_path: Path) -> None:
    c1 = cell()
    lock = new_lock(
        "sweep",
        [c1],
        reason="plan",
        experiment_id="exp",
        experiment_source_hash="abc",
    )
    lock, added = extend_lock(
        lock,
        [c1, cell("rank-fuse")],
        reason="observed pattern",
        experiment_id="exp",
        experiment_source_hash="def",
    )
    assert [c.label for c in added] == ["rank-fuse"]
    assert [g.index for g in lock.generations] == [0, 1]
    path = tmp_path / "sweep.lock.json"
    save_lock(lock, path)
    assert load_lock(path) == lock

    lock, added = extend_lock(
        lock,
        [cell("rank-fuse")],
        reason="edited experiment",
        experiment_id="exp",
        experiment_source_hash="ghi",
        retire_missing=True,
    )
    assert added == []
    assert [c.label for c in lock.active_cells()] == ["rank-fuse"]
    assert lock.generations[-1].retired_cell_ids == [c1.cell_id]


def test_result_store_is_the_checkpoint(tmp_path: Path) -> None:
    c = cell()
    sid = c.shard_id("a", adapter_version="1", dataset_hash=c.dataset_hash)
    result = ShardResult(
        shard_id=sid,
        cell_id=c.cell_id,
        generation=0,
        benchmark=c.benchmark,
        instance_id="a",
        sut_hash=c.sut.hash,
        status=ShardStatus.RESOLVED,
        resolved=True,
    )
    store = ResultStore(tmp_path)
    assert not store.has("sweep", sid)
    store.put("sweep", result)
    assert store.has("sweep", sid)
    assert store.get_all("sweep") == [result]
    assert json.loads((tmp_path / "sweep" / f"{sid}.json").read_text())["resolved"] is True


def test_aggregate_counts_terminal_errors_as_failures() -> None:
    c = cell()
    c = c.model_copy(update={"instances": ["a", "b", "c"]})
    resolved = ShardResult(
        shard_id="resolved",
        cell_id=c.cell_id,
        generation=0,
        benchmark=c.benchmark,
        instance_id="a",
        sut_hash=c.sut.hash,
        status=ShardStatus.RESOLVED,
        resolved=True,
    )
    error = ShardResult(
        shard_id="error",
        cell_id=c.cell_id,
        generation=0,
        benchmark=c.benchmark,
        instance_id="b",
        sut_hash=c.sut.hash,
        status=ShardStatus.ERROR,
    )

    (row,) = aggregate("sweep", [c], [resolved, error]).cells

    assert row["resolved"] == 1
    assert row["n_graded"] == 3
    assert row["n_terminal"] == 2
    assert row["n_completed"] == 1
    assert row["n_errors"] == 1
    assert row["n_missing"] == 1
    assert row["rate"] == pytest.approx(1 / 3)
    assert row["completed_rate"] == 1.0
    assert row["complete"] is False


def test_aggregate_rejects_result_from_different_submitted_shard() -> None:
    c = cell()
    result = ShardResult(
        shard_id="old-shard",
        cell_id=c.cell_id,
        generation=0,
        benchmark=c.benchmark,
        instance_id="a",
        sut_hash=c.sut.hash,
        status=ShardStatus.RESOLVED,
        resolved=True,
        adapter_version="old",
        dataset_hash=c.dataset_hash,
    )
    expected = SubmittedShard(
        shard_id="new-shard",
        cell_id=c.cell_id,
        generation=0,
        benchmark=c.benchmark,
        instance_id="a",
        sut_hash=c.sut.hash,
        adapter_version="new",
        dataset_hash=c.dataset_hash,
    )

    with pytest.raises(ValueError, match="does not match its submitted shard"):
        aggregate(
            "sweep",
            [c],
            [result],
            submitted_shards={c.cell_id: {"a": expected}},
        )

