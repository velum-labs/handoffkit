"""S3-backed result and artifact storage for cloud HyperKit runs."""

from __future__ import annotations

from importlib import import_module
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from hyperkit.core.models import ShardResult
from hyperkit.core.store import ResultStore


def parse_s3_uri(uri: str) -> tuple[str, str]:
    """Return ``(bucket, key)`` for an S3 URI."""

    parsed = urlparse(uri)
    if parsed.scheme != "s3" or not parsed.netloc:
        raise ValueError(f"expected an s3:// URI, got {uri!r}")
    return parsed.netloc, parsed.path.lstrip("/")


def _default_s3_client() -> Any:
    try:
        boto3 = import_module("boto3")
    except ModuleNotFoundError as exc:
        raise RuntimeError("S3 support requires the 'hyperkit[aws]' extra") from exc
    return boto3.client("s3")


class S3ResultStore(ResultStore):
    """ResultStore-compatible storage under ``runs/<sweep_id>`` in S3."""

    def __init__(self, bucket: str, *, prefix: str = "", client: Any | None = None):
        if not bucket:
            raise ValueError("bucket must not be empty")
        self.bucket = bucket
        self.prefix = prefix.strip("/")
        self.client = client if client is not None else _default_s3_client()

    def _key(self, key: str) -> str:
        return f"{self.prefix}/{key}" if self.prefix else key

    def result_key(self, sweep_id: str, shard_id: str) -> str:
        return self._key(f"runs/{sweep_id}/results/{shard_id}.json")

    def has(self, sweep_id: str, shard_id: str) -> bool:
        try:
            self.client.head_object(Bucket=self.bucket, Key=self.result_key(sweep_id, shard_id))
        except Exception as exc:
            response = getattr(exc, "response", {})
            error = response.get("Error", {}) if isinstance(response, dict) else {}
            if str(error.get("Code", "")) in {"404", "NoSuchKey", "NotFound"}:
                return False
            raise
        return True

    def put(self, sweep_id: str, result: ShardResult) -> None:
        self.client.put_object(
            Bucket=self.bucket,
            Key=self.result_key(sweep_id, result.shard_id),
            Body=result.model_dump_json(indent=2).encode(),
            ContentType="application/json",
        )

    def get_all(self, sweep_id: str) -> list[ShardResult]:
        prefix = self._key(f"runs/{sweep_id}/results/")
        results: list[ShardResult] = []
        for item in self._list_objects(prefix):
            key = item.get("Key", "")
            if not key.endswith(".json"):
                continue
            response = self.client.get_object(Bucket=self.bucket, Key=key)
            results.append(ShardResult.model_validate_json(response["Body"].read()))
        return sorted(results, key=lambda result: result.shard_id)

    def present_ids(self, sweep_id: str) -> set[str]:
        prefix = self._key(f"runs/{sweep_id}/results/")
        return {
            Path(item["Key"]).stem
            for item in self._list_objects(prefix)
            if item.get("Key", "").endswith(".json")
        }

    def artifact_prefix(
        self,
        sweep_id: str,
        benchmark: str,
        cell_id: str,
        instance_id: str,
    ) -> str:
        return self._key(f"runs/{sweep_id}/artifacts/{benchmark}/{cell_id}/{instance_id}/")

    def upload_artifacts(
        self,
        sweep_id: str,
        benchmark: str,
        cell_id: str,
        instance_id: str,
        workdir: Path,
    ) -> list[str]:
        """Upload every regular file below a shard work directory."""

        root = Path(workdir)
        if not root.exists():
            return []
        prefix = self.artifact_prefix(sweep_id, benchmark, cell_id, instance_id)
        uploaded: list[str] = []
        for path in sorted(root.rglob("*")):
            if not path.is_file():
                continue
            key = f"{prefix}{path.relative_to(root).as_posix()}"
            upload_file = getattr(self.client, "upload_file", None)
            if callable(upload_file):
                upload_file(str(path), self.bucket, key)
            else:
                self.client.put_object(Bucket=self.bucket, Key=key, Body=path.read_bytes())
            uploaded.append(key)
        return uploaded

    def _list_objects(self, prefix: str) -> list[dict[str, Any]]:
        objects: list[dict[str, Any]] = []
        token: str | None = None
        while True:
            kwargs: dict[str, Any] = {"Bucket": self.bucket, "Prefix": prefix}
            if token is not None:
                kwargs["ContinuationToken"] = token
            response = self.client.list_objects_v2(**kwargs)
            objects.extend(response.get("Contents", []))
            if not response.get("IsTruncated"):
                return objects
            token = response.get("NextContinuationToken")
            if not token:
                raise RuntimeError("S3 listing was truncated without a continuation token")
