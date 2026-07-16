"""AWS Batch array-job compute backend."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import time
from collections.abc import Callable, Sequence
from importlib import import_module
from typing import Any

from hyperkit.backends.s3 import S3ResultStore
from hyperkit.core.models import BackendSubmission, ShardPlan, ShardResult
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
        image_digest: str = "",
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
        self.image_digest = image_digest
        self.batch_client = batch_client if batch_client is not None else _default_batch_client()
        self.adapter_version_for = adapter_version_for or _adapter_version
        self.last_submitted_job_ids: list[str] = []

    def submit(
        self,
        shards: Sequence[ShardPlan],
        sweep_id: str,
    ) -> BackendSubmission:
        """Submit exact materialized shards and return backend acknowledgements."""

        self.last_submitted_job_ids = []
        if not shards:
            return BackendSubmission(image_digest=self.image_digest)

        present = self.store.present_ids(sweep_id)
        accepted_ids = {shard.shard_id for shard in shards if shard.shard_id in present}
        missing: dict[str, ShardPlan] = {}
        for shard in shards:
            current_version = self.adapter_version_for(shard.cell.benchmark)
            if current_version != shard.adapter_version:
                raise ValueError(
                    f"adapter version drift for {shard.cell.benchmark}: "
                    f"planned {shard.adapter_version!r}, runtime {current_version!r}"
                )
            if shard.image_digest != self.image_digest:
                raise ValueError(
                    f"image digest drift: planned {shard.image_digest!r}, "
                    f"backend {self.image_digest!r}"
                )
            expected_id = shard.cell.shard_id(
                shard.instance_id,
                adapter_version=shard.adapter_version,
                dataset_hash=shard.cell.dataset_hash,
                source_sha=shard.source_sha,
                image_digest=shard.image_digest,
            )
            if shard.shard_id != expected_id:
                raise ValueError(
                    f"planned shard id {shard.shard_id!r} does not match "
                    f"materialized identity {expected_id!r}"
                )
            if shard.shard_id not in present:
                missing.setdefault(shard.shard_id, shard)
        if not missing:
            return BackendSubmission(
                accepted_shard_ids=sorted(accepted_ids),
                image_digest=self.image_digest,
            )

        by_cell: dict[tuple[str, int], list[ShardPlan]] = {}
        for shard in missing.values():
            by_cell.setdefault((shard.cell.cell_id, shard.generation), []).append(shard)

        manifest_uris: list[str] = []
        errors: list[str] = []
        for cell_key in sorted(by_cell):
            entries = sorted(by_cell[cell_key], key=lambda item: item.shard_id)
            cell_id, _generation = cell_key
            if len(entries) > _MAX_ARRAY_SIZE:
                raise ValueError(
                    f"cell {cell_id} has {len(entries)} missing shards; "
                    f"AWS Batch arrays support at most {_MAX_ARRAY_SIZE}"
                )
            try:
                job_id, manifest_uri, acknowledged, submit_errors = self._submit_cell(
                    sweep_id,
                    entries,
                )
            except Exception as exc:
                errors.append(f"{type(exc).__name__}: {exc}")
                break
            accepted_ids.update(acknowledged)
            errors.extend(submit_errors)
            if manifest_uri is not None:
                manifest_uris.append(manifest_uri)
            if job_id is not None:
                self.last_submitted_job_ids.append(job_id)
            if submit_errors:
                break
        return BackendSubmission(
            accepted_shard_ids=sorted(accepted_ids),
            job_ids=list(self.last_submitted_job_ids),
            manifest_uris=manifest_uris,
            errors=errors,
            image_digest=self.image_digest,
        )

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
        entries: list[ShardPlan],
    ) -> tuple[str | None, str | None, set[str], list[str]]:
        cell = entries[0].cell
        generation = entries[0].generation
        manifest = {
            str(index): {
                # A shard only needs its own instance. Since instances are not
                # part of cell identity, this avoids an O(n^2) array manifest.
                "cell": shard.cell.model_copy(
                    update={"instances": [shard.instance_id]}
                ).model_dump(mode="json"),
                "generation": shard.generation,
                "instance_id": shard.instance_id,
                "shard_id": shard.shard_id,
                "adapter_version": shard.adapter_version,
                "source_sha": shard.source_sha,
                "image_digest": self.image_digest,
            }
            for index, shard in enumerate(entries)
        }
        encoded = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
        digest = hashlib.sha256(encoded).hexdigest()[:16]
        manifest_key = self.store._key(f"runs/{sweep_id}/manifests/{cell.cell_id}-{digest}.json")
        receipt_prefix = self.store._key(
            f"runs/{sweep_id}/submissions/{cell.cell_id}-{digest}"
        )
        receipts = self._submission_receipts(receipt_prefix)
        receipt_job_ids = [
            str(receipt["job_id"])
            for _key, receipt in receipts
            if receipt.get("job_id")
        ]
        if receipt_job_ids:
            statuses = self.status(receipt_job_ids)
            if any(status not in _TERMINAL_STATUSES for status in statuses.values()):
                manifest_uri = next(
                    (
                        str(receipt.get("manifest_s3_uri"))
                        for _key, receipt in reversed(receipts)
                        if receipt.get("manifest_s3_uri")
                    ),
                    f"s3://{self.store.bucket}/{manifest_key}",
                )
                return (
                    None,
                    manifest_uri,
                    {entry.shard_id for entry in entries},
                    [],
                )

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
        job_id = str(response["jobId"])
        attempt = len(receipts) + 1
        receipt_key = f"{receipt_prefix}-attempt-{attempt}.json"
        receipt_errors: list[str] = []
        try:
            self.store.client.put_object(
                Bucket=self.store.bucket,
                Key=receipt_key,
                Body=json.dumps(
                    {
                        "job_id": job_id,
                        "job_definition": self.job_definition,
                        "manifest_s3_uri": manifest_uri,
                        "manifest_sha256": hashlib.sha256(encoded).hexdigest(),
                        "generation": generation,
                        "image_digest": self.image_digest,
                        "shards": [
                            entry.submitted_shard().model_dump(mode="json")
                            for entry in entries
                        ],
                    },
                    sort_keys=True,
                ).encode(),
                ContentType="application/json",
            )
            cell_key = self.store._key(
                f"runs/{sweep_id}/cells/{cell.cell_id}.json"
            )
            self.store.client.put_object(
                Bucket=self.store.bucket,
                Key=cell_key,
                Body=json.dumps(
                    {
                        "cell": cell.model_dump(mode="json"),
                        "generation": generation,
                    },
                    sort_keys=True,
                ).encode(),
                ContentType="application/json",
            )
        except Exception as exc:
            receipt_errors.append(
                f"submitted job {job_id} but failed to persist its receipt: "
                f"{type(exc).__name__}: {exc}"
            )
        return (
            job_id,
            manifest_uri,
            {entry.shard_id for entry in entries},
            receipt_errors,
        )

    def _submission_receipts(
        self,
        receipt_prefix: str,
    ) -> list[tuple[str, dict[str, Any]]]:
        receipts: list[tuple[str, dict[str, Any]]] = []
        for item in self.store._list_objects(receipt_prefix):
            key = str(item.get("Key", ""))
            if not key.endswith(".json"):
                continue
            payload = self._get_json_if_present(key)
            if payload is not None:
                receipts.append((key, payload))
        return sorted(receipts, key=lambda item: item[0])

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

    def submit(
        self,
        shards: Sequence[ShardPlan],
        sweep_id: str,
    ) -> BackendSubmission:
        return self._get_delegate().submit(shards, sweep_id)

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
        "image_digest": os.environ.get("HYPERKIT_RUNNER_IMAGE_DIGEST"),
    }
    missing = [key for key, value in required.items() if not value]
    if missing:
        names = ", ".join(missing)
        raise RuntimeError(f"aws-batch backend is missing required environment config: {names}")
    return AwsBatchComputeBackend(
        bucket=required["bucket"] or "",
        job_queue=required["job_queue"] or "",
        job_definition=required["job_definition"] or "",
        image_digest=required["image_digest"] or "",
        prefix=os.environ.get("HYPERKIT_S3_PREFIX", ""),
        generation=int(os.environ.get("HYPERKIT_GENERATION", "0")),
    )


def factory() -> _EnvironmentAwsBatchBackend:
    """Return the lazy backend used by the plugin registry."""

    return _EnvironmentAwsBatchBackend()
