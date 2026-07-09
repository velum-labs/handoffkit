from __future__ import annotations

import json
from pathlib import Path

import hyperkit.adapters  # noqa: F401
from hyperkit.core.ids import canonical_json, hash_ids, hash_obj
from hyperkit.core.lock import extend_lock, load_lock, new_lock, save_lock
from hyperkit.core.models import Cell, ShardResult, ShardStatus, TopologySpec
from hyperkit.core.store import ResultStore


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

