"""AWS Batch array-job compute backend."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import time
from collections import defaultdict
from collections.abc import Callable, Sequence
from importlib import import_module
from typing import Any

from hyperkit.backends.s3 import S3ResultStore
from hyperkit.core.models import Cell, ShardResult
from hyperkit.core.registry import get_benchmark

_MAX_ARRAY_SIZE = 10_000
_MAX_DESCRIBE_JOBS = 100
_TERMINAL_STATUSES = {"SUCCEEDED", "FAILED"}


def _default_batch_client() -> Any:
    try:
        boto3 = import_module("boto3")
    except ModuleNotFoundError as exc:
        raise RuntimeError("AWS Batch support requires the 'hyperkit[aws]' extra") from exc
    return boto3.client("batch")


def _adapter_version(benchmark: str) -> str:
    return get_benchmark(benchmark).version


class AwsBatchComputeBackend:
    """Submit each cell's missing shards as one AWS Batch array job."""

    name = "aws-batch"

    def __init__(
        self,
        *,
        bucket: str,
        job_queue: str,
        job_definition: str,
        prefix: str = "",
        generation: int = 0,
        s3_client: Any | None = None,
        batch_client: Any | None = None,
        adapter_version_for: Callable[[str], str] | None = None,
    ):
        if not job_queue or not job_definition:
            raise ValueError("job_queue and job_definition must not be empty")
        self.store = S3ResultStore(bucket, prefix=prefix, client=s3_client)
        self.job_queue = job_queue
        self.job_definition = job_definition
        self.generation = generation
        self.batch_client = batch_client if batch_client is not None else _default_batch_client()
        self.adapter_version_for = adapter_version_for or _adapter_version
        self.last_submitted_job_ids: list[str] = []

    def submit(self, shards: Sequence[tuple[Cell, str]], sweep_id: str) -> None:
        """Submit missing shards, deduplicated and grouped by cell."""

        self.last_submitted_job_ids = []
        if not shards:
            return

        present = self.store.present_ids(sweep_id)
        versions: dict[str, str] = {}
        missing: dict[str, tuple[Cell, str, str]] = {}
        for cell, instance_id in shards:
            version = versions.get(cell.benchmark)
            if version is None:
                version = self.adapter_version_for(cell.benchmark)
                versions[cell.benchmark] = version
            shard_id = cell.shard_id(
                instance_id,
                adapter_version=version,
                dataset_hash=cell.dataset_hash,
            )
            if shard_id not in present:
                missing.setdefault(shard_id, (cell, instance_id, shard_id))
        if not missing:
            return

        by_cell: dict[str, list[tuple[Cell, str, str]]] = defaultdict(list)
        for entry in missing.values():
            by_cell[entry[0].cell_id].append(entry)

        for cell_id in sorted(by_cell):
            entries = sorted(by_cell[cell_id], key=lambda item: item[2])
            if len(entries) > _MAX_ARRAY_SIZE:
                raise ValueError(
                    f"cell {cell_id} has {len(entries)} missing shards; "
                    f"AWS Batch arrays support at most {_MAX_ARRAY_SIZE}"
                )
            job_id = self._submit_cell(sweep_id, entries)
            if job_id is not None:
                self.last_submitted_job_ids.append(job_id)

    def results(self, sweep_id: str) -> list[ShardResult]:
        return self.store.get_all(sweep_id)

    def status(self, job_ids: Sequence[str]) -> dict[str, str]:
        if not job_ids:
            return {}
        statuses: dict[str, str] = {}
        for start in range(0, len(job_ids), _MAX_DESCRIBE_JOBS):
            chunk = list(job_ids[start : start + _MAX_DESCRIBE_JOBS])
            response = self.batch_client.describe_jobs(jobs=chunk)
            statuses.update({job["jobId"]: job["status"] for job in response.get("jobs", [])})
        return {job_id: statuses.get(job_id, "UNKNOWN") for job_id in job_ids}

    def poll(
        self,
        job_ids: Sequence[str],
        *,
        interval_s: float = 10.0,
        timeout_s: float | None = None,
    ) -> dict[str, str]:
        """Wait for all jobs to finish and return their final statuses."""

        started = time.monotonic()
        while True:
            statuses = self.status(job_ids)
            if all(status in _TERMINAL_STATUSES for status in statuses.values()):
                return statuses
            if timeout_s is not None and time.monotonic() - started >= timeout_s:
                raise TimeoutError(f"AWS Batch jobs did not finish within {timeout_s}s")
            time.sleep(interval_s)

    def _submit_cell(
        self,
        sweep_id: str,
        entries: list[tuple[Cell, str, str]],
    ) -> str | None:
        cell = entries[0][0]
        manifest = {
            str(index): {
                # A shard only needs its own instance. Since instances are not
                # part of cell identity, this avoids an O(n^2) array manifest.
                "cell": item_cell.model_copy(update={"instances": [instance_id]}).model_dump(
                    mode="json"
                ),
                "generation": self.generation,
                "instance_id": instance_id,
                "shard_id": shard_id,
            }
            for index, (item_cell, instance_id, shard_id) in enumerate(entries)
        }
        encoded = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
        digest = hashlib.sha256(encoded).hexdigest()[:16]
        manifest_key = self.store._key(f"runs/{sweep_id}/manifests/{cell.cell_id}-{digest}.json")
        receipt_key = self.store._key(f"runs/{sweep_id}/submissions/{cell.cell_id}-{digest}.json")
        receipt = self._get_json_if_present(receipt_key)
        if receipt is not None and receipt.get("job_id"):
            return None

        self.store.client.put_object(
            Bucket=self.store.bucket,
            Key=manifest_key,
            Body=encoded,
            ContentType="application/json",
        )
        manifest_uri = f"s3://{self.store.bucket}/{manifest_key}"
        environment = [
            {"name": "RUN_ID", "value": sweep_id},
            {"name": "MANIFEST_S3_URI", "value": manifest_uri},
        ]
        array_properties: dict[str, int] | None = None
        if len(entries) == 1:
            # AWS Batch array sizes start at two, so a resumed singleton is a
            # normal job with the equivalent explicit index.
            environment.append({"name": "ARRAY_INDEX", "value": "0"})
        else:
            array_properties = {"size": len(entries)}
            environment.append(
                # Batch injects the actual index as AWS_BATCH_JOB_ARRAY_INDEX.
                # The runner treats this sentinel as a request to read that native value.
                {"name": "ARRAY_INDEX", "value": "AWS_BATCH_JOB_ARRAY_INDEX"}
            )
        submit_kwargs: dict[str, Any] = {
            "jobName": _job_name(sweep_id, cell.cell_id, digest),
            "jobQueue": self.job_queue,
            "jobDefinition": self.job_definition,
            "containerOverrides": {
                "environment": environment,
                "resourceRequirements": [
                    {"type": "VCPU", "value": _number(cell.resource.vcpu)},
                    {
                        "type": "MEMORY",
                        "value": str(math.ceil(cell.resource.memory_gb * 1024)),
                    },
                ],
            },
            "timeout": {"attemptDurationSeconds": cell.resource.wall_clock_s},
        }
        if array_properties is not None:
            submit_kwargs["arrayProperties"] = array_properties
        response = self.batch_client.submit_job(**submit_kwargs)
        job_id = response["jobId"]
        self.store.client.put_object(
            Bucket=self.store.bucket,
            Key=receipt_key,
            Body=json.dumps(
                {"job_id": job_id, "manifest_s3_uri": manifest_uri},
                sort_keys=True,
            ).encode(),
            ContentType="application/json",
        )
        return str(job_id)

    def _get_json_if_present(self, key: str) -> dict[str, Any] | None:
        try:
            response = self.store.client.get_object(Bucket=self.store.bucket, Key=key)
        except Exception as exc:
            error_response = getattr(exc, "response", {})
            error = error_response.get("Error", {}) if isinstance(error_response, dict) else {}
            if str(error.get("Code", "")) in {"404", "NoSuchKey", "NotFound"}:
                return None
            raise
        value = json.loads(response["Body"].read())
        if not isinstance(value, dict):
            raise ValueError(f"invalid submission receipt at s3://{self.store.bucket}/{key}")
        return value


def _number(value: float) -> str:
    return str(int(value)) if value.is_integer() else str(value)


def _job_name(sweep_id: str, cell_id: str, digest: str) -> str:
    safe_sweep = re.sub(r"[^A-Za-z0-9_-]", "-", sweep_id).strip("-_") or "run"
    return f"hyperkit-{safe_sweep[:80]}-{cell_id}-{digest[:8]}"[:128]


class _EnvironmentAwsBatchBackend:
    """Lazy entry-point adapter that avoids AWS work during registry discovery."""

    name = "aws-batch"

    def __init__(self) -> None:
        self._delegate: AwsBatchComputeBackend | None = None

    def submit(self, shards: Sequence[tuple[Cell, str]], sweep_id: str) -> None:
        self._get_delegate().submit(shards, sweep_id)

    def results(self, sweep_id: str) -> list[ShardResult]:
        return self._get_delegate().results(sweep_id)

    def status(self, job_ids: Sequence[str]) -> dict[str, str]:
        return self._get_delegate().status(job_ids)

    def poll(
        self,
        job_ids: Sequence[str],
        *,
        interval_s: float = 10.0,
        timeout_s: float | None = None,
    ) -> dict[str, str]:
        return self._get_delegate().poll(
            job_ids,
            interval_s=interval_s,
            timeout_s=timeout_s,
        )

    def _get_delegate(self) -> AwsBatchComputeBackend:
        if self._delegate is None:
            self._delegate = _backend_from_environment()
        return self._delegate


def _backend_from_environment() -> AwsBatchComputeBackend:
    """Construct a configured backend from runtime environment variables."""

    required = {
        "bucket": os.environ.get("HYPERKIT_AWS_BUCKET") or os.environ.get("HYPERKIT_S3_BUCKET"),
        "job_queue": os.environ.get("HYPERKIT_AWS_BATCH_JOB_QUEUE"),
        "job_definition": os.environ.get("HYPERKIT_AWS_BATCH_JOB_DEFINITION"),
    }
    missing = [key for key, value in required.items() if not value]
    if missing:
        names = ", ".join(missing)
        raise RuntimeError(f"aws-batch backend is missing required environment config: {names}")
    return AwsBatchComputeBackend(
        bucket=required["bucket"] or "",
        job_queue=required["job_queue"] or "",
        job_definition=required["job_definition"] or "",
        prefix=os.environ.get("HYPERKIT_S3_PREFIX", ""),
        generation=int(os.environ.get("HYPERKIT_GENERATION", "0")),
    )


def factory() -> _EnvironmentAwsBatchBackend:
    """Return the lazy backend used by the plugin registry."""

    return _EnvironmentAwsBatchBackend()
