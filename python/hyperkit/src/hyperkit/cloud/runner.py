"""Execute one manifest entry inside a generic cloud runner container."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import hyperkit.adapters  # noqa: F401  (registers built-in adapters)
import hyperkit.suts  # noqa: F401  (registers built-in SUTs)
from hyperkit.backends.s3 import S3ResultStore, parse_s3_uri
from hyperkit.core.models import Cell
from hyperkit.core.orchestrator import RunOrchestrator
from hyperkit.core.registry import get_benchmark, get_sut


def _required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def _array_index() -> int:
    explicit = os.environ.get("ARRAY_INDEX", "")
    if explicit.isdecimal():
        return int(explicit)
    native = os.environ.get("AWS_BATCH_JOB_ARRAY_INDEX", "")
    if native.isdecimal():
        return int(native)
    raise RuntimeError("ARRAY_INDEX or AWS_BATCH_JOB_ARRAY_INDEX must be a non-negative integer")


def _store_prefix(manifest_key: str, run_id: str) -> str:
    marker = f"runs/{run_id}/manifests/"
    if manifest_key.startswith(marker):
        return ""
    separator = f"/{marker}"
    if separator not in manifest_key:
        raise ValueError(f"manifest key is not under {marker!r}: {manifest_key!r}")
    return manifest_key.split(separator, maxsplit=1)[0]


def _load_entry(store: S3ResultStore, key: str, index: int) -> dict[str, Any]:
    response = store.client.get_object(Bucket=store.bucket, Key=key)
    manifest = json.loads(response["Body"].read())
    if not isinstance(manifest, dict):
        raise ValueError("manifest must be a JSON object keyed by array index")
    entry = manifest.get(str(index))
    if not isinstance(entry, dict):
        raise KeyError(f"array index {index} is absent from the manifest")
    return entry


def _configure_otel() -> None:
    endpoint = os.environ.get("HYPERKIT_OTEL_ENDPOINT")
    if endpoint and "OTEL_EXPORTER_OTLP_ENDPOINT" not in os.environ:
        os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"] = endpoint


def main() -> int:
    """Run exactly one array entry and checkpoint its result and artifacts."""

    run_id = _required_env("RUN_ID")
    manifest_uri = _required_env("MANIFEST_S3_URI")
    index = _array_index()
    bucket, manifest_key = parse_s3_uri(manifest_uri)
    store = S3ResultStore(
        bucket,
        prefix=_store_prefix(manifest_key, run_id),
    )
    entry = _load_entry(store, manifest_key, index)
    cell = Cell.model_validate(entry.get("cell"))
    instance_id = str(entry["instance_id"])
    generation = int(entry.get("generation", 0))

    _configure_otel()
    adapter = get_benchmark(cell.benchmark)
    sut = get_sut(cell.sut.kind)
    planned_adapter_version = str(entry.get("adapter_version", ""))
    if planned_adapter_version != adapter.version:
        raise ValueError(
            f"manifest adapter version {planned_adapter_version!r} does not match "
            f"runner version {adapter.version!r}"
        )
    planned_source_sha = str(entry.get("source_sha", ""))
    runtime_source_sha = os.environ.get("HYPERKIT_SOURCE_SHA", "")
    if planned_source_sha != runtime_source_sha:
        raise ValueError(
            f"manifest source SHA {planned_source_sha!r} does not match "
            f"runner source SHA {runtime_source_sha!r}"
        )
    planned_image_digest = str(entry.get("image_digest", ""))
    runtime_image_digest = os.environ.get("HYPERKIT_RUNNER_IMAGE_DIGEST", "")
    if planned_image_digest != runtime_image_digest:
        raise ValueError(
            f"manifest image digest {planned_image_digest!r} does not match "
            f"runner image digest {runtime_image_digest!r}"
        )
    expected_shard_id = cell.shard_id(
        instance_id,
        adapter_version=adapter.version,
        dataset_hash=cell.dataset_hash,
        source_sha=planned_source_sha,
        image_digest=planned_image_digest,
    )
    if entry.get("shard_id") != expected_shard_id:
        raise ValueError(
            f"manifest shard id {entry.get('shard_id')!r} does not match {expected_shard_id!r}"
        )

    work_root = Path(os.environ.get("HYPERKIT_WORK_ROOT", "/tmp/hyperkit"))
    benchmark_root = work_root / run_id / cell.benchmark
    orchestrator = RunOrchestrator(
        sweep_id=run_id,
        generation=generation,
        source_sha=planned_source_sha,
        image_digest=planned_image_digest,
        adapter=adapter,
        sut=sut,
        store=store,
        work_root=benchmark_root,
    )
    result = orchestrator.run(cell, instance_id)
    workdir = benchmark_root / cell.cell_id / instance_id
    artifact_keys = store.upload_artifacts(
        run_id,
        cell.benchmark,
        cell.cell_id,
        instance_id,
        workdir,
    )
    print(
        json.dumps(
            {
                "artifacts_uploaded": len(artifact_keys),
                "run_id": run_id,
                "shard_id": result.shard_id,
                "status": result.status,
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
