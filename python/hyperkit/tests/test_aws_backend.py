from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any

import hyperkit.cloud.runner as cloud_runner
from hyperkit.backends.aws_batch import AwsBatchComputeBackend
from hyperkit.backends.s3 import S3ResultStore
from hyperkit.core.models import (
    Cell,
    ResourceProfile,
    ShardResult,
    ShardStatus,
    TopologySpec,
)


class FakeClientError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.response = {"Error": {"Code": code}}


class FakeS3:
    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], bytes] = {}

    def put_object(self, *, Bucket: str, Key: str, Body: bytes, **_: Any) -> None:
        self.objects[(Bucket, Key)] = Body

    def get_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        try:
            value = self.objects[(Bucket, Key)]
        except KeyError as exc:
            raise FakeClientError("NoSuchKey") from exc
        return {"Body": io.BytesIO(value)}

    def head_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        if (Bucket, Key) not in self.objects:
            raise FakeClientError("404")
        return {}

    def list_objects_v2(self, *, Bucket: str, Prefix: str, **_: Any) -> dict[str, Any]:
        keys = sorted(
            key for bucket, key in self.objects if bucket == Bucket and key.startswith(Prefix)
        )
        return {"Contents": [{"Key": key} for key in keys], "IsTruncated": False}


class FakeBatch:
    def __init__(self) -> None:
        self.submissions: list[dict[str, Any]] = []

    def submit_job(self, **kwargs: Any) -> dict[str, str]:
        self.submissions.append(kwargs)
        return {"jobId": f"job-{len(self.submissions)}"}

    def describe_jobs(self, *, jobs: list[str]) -> dict[str, Any]:
        return {"jobs": [{"jobId": job_id, "status": "SUCCEEDED"} for job_id in jobs]}


class FakeGrader:
    def grade(self, instance_id: str, raw_output: dict[str, Any]) -> dict[str, Any]:
        return {"resolved": raw_output["instance_id"] == instance_id}


class FakeAdapter:
    name = "benchmark"
    version = "7"

    def run_instance(
        self, instance_id: str, sut_endpoint: str, workdir: Path, params: dict[str, Any]
    ) -> dict[str, Any]:
        assert sut_endpoint == "http://sut/v1"
        workdir.mkdir(parents=True, exist_ok=True)
        (workdir / "report.json").write_text('{"ok": true}')
        return {"instance_id": instance_id}

    def grader(self) -> FakeGrader:
        return FakeGrader()


class FakeSut:
    kind = "opaque"

    def start(self, spec: TopologySpec, workdir: Path) -> str:
        return "http://sut/v1"

    def stop(self) -> None:
        pass


def _cell(label: str, instances: list[str], *, memory_gb: float = 2.5) -> Cell:
    return Cell(
        sut=TopologySpec(kind="opaque", params={"label": label}),
        benchmark="benchmark",
        instances=instances,
        dataset_hash="dataset",
        resource=ResourceProfile(vcpu=2, memory_gb=memory_gb, wall_clock_s=90),
        label=label,
    )


def _result(cell: Cell, instance_id: str) -> ShardResult:
    return ShardResult(
        shard_id=cell.shard_id(
            instance_id,
            adapter_version="7",
            dataset_hash=cell.dataset_hash,
        ),
        cell_id=cell.cell_id,
        generation=3,
        benchmark=cell.benchmark,
        instance_id=instance_id,
        sut_hash=cell.sut.hash,
        status=ShardStatus.RESOLVED,
        resolved=True,
    )


def test_s3_result_store_keys_round_trip_and_artifacts(tmp_path: Path) -> None:
    s3 = FakeS3()
    store = S3ResultStore("bucket", prefix="team", client=s3)
    cell = _cell("a", ["instance"])
    result = _result(cell, "instance")

    assert not store.has("run", result.shard_id)
    store.put("run", result)

    expected_key = f"team/runs/run/results/{result.shard_id}.json"
    assert ("bucket", expected_key) in s3.objects
    assert store.has("run", result.shard_id)
    assert store.present_ids("run") == {result.shard_id}
    assert store.get_all("run") == [result]

    (tmp_path / "nested").mkdir()
    (tmp_path / "nested" / "report.json").write_text("{}")
    uploaded = store.upload_artifacts("run", "benchmark", cell.cell_id, "instance", tmp_path)
    assert uploaded == [
        f"team/runs/run/artifacts/benchmark/{cell.cell_id}/instance/nested/report.json"
    ]


def test_aws_batch_groups_missing_shards_and_retries_idempotently() -> None:
    s3 = FakeS3()
    batch = FakeBatch()
    first = _cell("first", ["a", "b"])
    second = _cell("second", ["c", "d"], memory_gb=3)
    store = S3ResultStore("bucket", prefix="prefix", client=s3)
    store.put("run", _result(first, "a"))
    backend = AwsBatchComputeBackend(
        bucket="bucket",
        prefix="prefix",
        job_queue="queue",
        job_definition="definition",
        generation=3,
        s3_client=s3,
        batch_client=batch,
        adapter_version_for=lambda _: "7",
    )
    shards = [
        (first, "a"),
        (first, "b"),
        (first, "b"),
        (second, "c"),
        (second, "d"),
    ]

    backend.submit(shards, "run")

    assert sorted(call.get("arrayProperties", {}).get("size", 1) for call in batch.submissions) == [
        1,
        2,
    ]
    assert backend.last_submitted_job_ids == ["job-1", "job-2"]
    calls_by_memory = {
        call["containerOverrides"]["resourceRequirements"][1]["value"]: call
        for call in batch.submissions
    }
    first_call = calls_by_memory["2560"]
    assert first_call["containerOverrides"]["resourceRequirements"] == [
        {"type": "VCPU", "value": "2"},
        {"type": "MEMORY", "value": "2560"},
    ]
    environment = {
        item["name"]: item["value"] for item in first_call["containerOverrides"]["environment"]
    }
    assert environment["RUN_ID"] == "run"
    assert environment["ARRAY_INDEX"] == "0"
    assert "arrayProperties" not in first_call
    array_environment = {
        item["name"]: item["value"]
        for item in calls_by_memory["3072"]["containerOverrides"]["environment"]
    }
    assert array_environment["ARRAY_INDEX"] == "AWS_BATCH_JOB_ARRAY_INDEX"
    assert calls_by_memory["3072"]["arrayProperties"] == {"size": 2}
    bucket, key = environment["MANIFEST_S3_URI"].removeprefix("s3://").split("/", 1)
    manifest = json.loads(s3.objects[(bucket, key)])
    assert manifest["0"]["instance_id"] == "b"
    assert manifest["0"]["generation"] == 3
    assert manifest["0"]["shard_id"] == _result(first, "b").shard_id

    backend.submit(shards, "run")

    assert len(batch.submissions) == 2
    assert backend.last_submitted_job_ids == []
    assert backend.status(["job-1", "job-2"]) == {
        "job-1": "SUCCEEDED",
        "job-2": "SUCCEEDED",
    }
    assert backend.poll(["job-1"], interval_s=0) == {"job-1": "SUCCEEDED"}


def test_aws_batch_empty_submit_does_nothing() -> None:
    s3 = FakeS3()
    batch = FakeBatch()
    backend = AwsBatchComputeBackend(
        bucket="bucket",
        job_queue="queue",
        job_definition="definition",
        s3_client=s3,
        batch_client=batch,
    )

    backend.submit([], "run")

    assert batch.submissions == []
    assert s3.objects == {}


def test_aws_batch_rejects_cells_over_array_limit() -> None:
    s3 = FakeS3()
    batch = FakeBatch()
    instances = [f"instance-{index}" for index in range(10_001)]
    cell = _cell("large", instances)
    backend = AwsBatchComputeBackend(
        bucket="bucket",
        job_queue="queue",
        job_definition="definition",
        s3_client=s3,
        batch_client=batch,
        adapter_version_for=lambda _: "7",
    )

    try:
        backend.submit([(cell, instance) for instance in instances], "run")
    except ValueError as exc:
        assert "at most 10000" in str(exc)
    else:
        raise AssertionError("expected the AWS Batch array limit to be enforced")

    assert batch.submissions == []


def test_cloud_runner_executes_one_entry_and_uploads_artifacts(
    tmp_path: Path, monkeypatch: Any
) -> None:
    s3 = FakeS3()
    store = S3ResultStore("bucket", prefix="prefix", client=s3)
    cell = _cell("runner", ["one"])
    shard_id = _result(cell, "one").shard_id
    manifest_key = f"prefix/runs/run/manifests/{cell.cell_id}.json"
    s3.put_object(
        Bucket="bucket",
        Key=manifest_key,
        Body=json.dumps(
            {
                "0": {
                    "cell": cell.model_dump(mode="json"),
                    "generation": 3,
                    "instance_id": "one",
                    "shard_id": shard_id,
                }
            }
        ).encode(),
    )
    monkeypatch.setenv("RUN_ID", "run")
    monkeypatch.setenv("MANIFEST_S3_URI", f"s3://bucket/{manifest_key}")
    monkeypatch.setenv("AWS_BATCH_JOB_ARRAY_INDEX", "0")
    monkeypatch.setenv("HYPERKIT_WORK_ROOT", str(tmp_path))
    monkeypatch.setenv("HYPERKIT_OTEL_ENDPOINT", "http://otel:4318")
    monkeypatch.delenv("ARRAY_INDEX", raising=False)
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    monkeypatch.setattr(cloud_runner, "S3ResultStore", lambda *_args, **_kwargs: store)
    monkeypatch.setattr(cloud_runner, "get_benchmark", lambda _name: FakeAdapter())
    monkeypatch.setattr(cloud_runner, "get_sut", lambda _kind: FakeSut())
    monkeypatch.setattr("hyperkit.core.orchestrator.configure", lambda: None)

    assert cloud_runner.main() == 0

    assert store.get_all("run")[0].generation == 3
    artifact_key = f"prefix/runs/run/artifacts/benchmark/{cell.cell_id}/one/report.json"
    assert s3.objects[("bucket", artifact_key)] == b'{"ok": true}'
    assert cloud_runner.os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"] == "http://otel:4318"
