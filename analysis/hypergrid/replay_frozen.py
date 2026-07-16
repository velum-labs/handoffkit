"""Replay historical Hypergrid checkpoints without provider calls.

S3 submission manifests define the intent-to-treat cohort. The script regrades
only retained selected code under the current pinned LiveCodeBench runner and
labels evidence that old schemas cannot causally attribute.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
from collections import Counter, defaultdict
from collections.abc import Iterable
from pathlib import Path
from typing import Any

import boto3

from hyperkit.adapters.livecodebench import _Sandbox, decode_tests, run_tests

DEFAULT_BUCKET = "hypergrid-batch-052777341990-us-east-1"
DEFAULT_SWEEPS = (
    "e002-sota-open-solo-screen",
    "e003-qwen37max-kernel-probes",
    "e004-truncation-fair-rescreen",
)


def _sha256(value: bytes | str) -> str:
    raw = value.encode() if isinstance(value, str) else value
    return hashlib.sha256(raw).hexdigest()


class EvidenceReader:
    def __init__(self, bucket: str):
        self.bucket = bucket
        self.client = boto3.client("s3", region_name="us-east-1")
        self.objects: dict[str, dict[str, Any]] = {}
        self.cache: dict[str, bytes] = {}

    def keys(self, prefix: str) -> list[str]:
        keys: list[str] = []
        token: str | None = None
        while True:
            kwargs: dict[str, Any] = {"Bucket": self.bucket, "Prefix": prefix}
            if token is not None:
                kwargs["ContinuationToken"] = token
            response = self.client.list_objects_v2(**kwargs)
            keys.extend(
                str(item["Key"])
                for item in response.get("Contents", [])
                if str(item.get("Key", "")).endswith(".json")
            )
            if not response.get("IsTruncated"):
                return sorted(keys)
            token = response.get("NextContinuationToken")
            if not token:
                raise RuntimeError("truncated S3 listing omitted its continuation token")

    def get(self, key: str) -> bytes:
        cached = self.cache.get(key)
        if cached is not None:
            return cached
        response = self.client.get_object(Bucket=self.bucket, Key=key)
        body = response["Body"].read()
        self.cache[key] = body
        self.objects[key] = {
            "key": key,
            "etag": str(response.get("ETag", "")).strip('"'),
            "size": len(body),
            "sha256": _sha256(body),
            "version_id": response.get("VersionId"),
        }
        return body

    def json(self, key: str) -> Any:
        return json.loads(self.get(key))


def _exclusions(path: Path) -> set[str]:
    return {
        line.strip()
        for line in path.read_text().splitlines()
        if line.strip() and not line.startswith("#")
    }


def _manifest_entries(reader: EvidenceReader, sweep_id: str) -> dict[str, dict[str, Any]]:
    entries: dict[str, dict[str, Any]] = {}
    for key in reader.keys(f"runs/{sweep_id}/manifests/"):
        manifest = reader.json(key)
        if not isinstance(manifest, dict):
            raise ValueError(f"invalid manifest object: {key}")
        for raw_entry in manifest.values():
            if not isinstance(raw_entry, dict):
                raise ValueError(f"invalid manifest entry: {key}")
            entry = {
                **raw_entry,
                "_cell_id": Path(key).stem.split("-", maxsplit=1)[0],
            }
            shard_id = str(entry["shard_id"])
            previous = entries.get(shard_id)
            if previous is not None and previous != entry:
                raise ValueError(f"conflicting manifest entries for shard {shard_id}")
            entries[shard_id] = entry
    return entries


def _results(reader: EvidenceReader, sweep_id: str) -> dict[str, dict[str, Any]]:
    results: dict[str, dict[str, Any]] = {}
    for key in reader.keys(f"runs/{sweep_id}/results/"):
        result = reader.json(key)
        if not isinstance(result, dict):
            raise ValueError(f"invalid result object: {key}")
        shard_id = str(result["shard_id"])
        if shard_id in results:
            raise ValueError(f"duplicate result for shard {shard_id}")
        result["_s3_key"] = key
        results[shard_id] = result
    return results


def _cell_labels(reader: EvidenceReader, sweep_id: str) -> dict[str, str]:
    labels: dict[str, str] = {}
    for key in reader.keys(f"runs/{sweep_id}/cells/"):
        payload = reader.json(key)
        cell = payload.get("cell", {}) if isinstance(payload, dict) else {}
        if isinstance(cell, dict):
            cell_id = Path(key).stem
            labels[cell_id] = str(cell.get("label") or cell_id)
    return labels


def _legacy_problem(row: dict[str, Any]) -> dict[str, Any]:
    """Declare the known historical stdin/no-starter assumptions explicitly."""

    normalized = dict(row)
    normalized["store_schema_version"] = 2
    normalized.setdefault("starter_code", "")
    normalized.setdefault("metadata", {"func_name": None})
    return normalized


def _legacy_oracle(result: dict[str, Any]) -> bool | None:
    raw = result.get("raw")
    if not isinstance(raw, dict):
        return None
    samples = raw.get("samples")
    if not isinstance(samples, list) or not samples:
        return None
    observed = [
        bool(sample.get("public_all")) and bool(sample.get("private_passed_all"))
        for sample in samples
        if isinstance(sample, dict)
    ]
    return any(observed) if observed else None


def _attribution(
    *,
    excluded: bool,
    result: dict[str, Any] | None,
    code: str,
    replay_pass: bool | None,
) -> str:
    if excluded:
        return "excluded_non_exact_task"
    if result is None:
        return "missing_checkpoint"
    if result.get("status") == "error":
        return "shard_error"
    if not code.strip():
        return "missing_generation_or_extraction_evidence"
    historical_pass = bool(result.get("resolved"))
    if replay_pass is not None and replay_pass != historical_pass:
        return "grading_flip_to_pass" if replay_pass else "grading_flip_to_fail"
    if replay_pass:
        return "pass"
    if _legacy_oracle(result):
        return "legacy_observed_selection_regret"
    return "legacy_generation_or_extraction_failure"


def _write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    path.write_text(
        "".join(
            json.dumps(row, sort_keys=True, separators=(",", ":")) + "\n"
            for row in rows
        )
    )


def replay(
    *,
    reader: EvidenceReader,
    sweeps: Iterable[str],
    output: Path,
    exclusions: set[str],
    timeout_s: float,
) -> list[dict[str, Any]]:
    output.mkdir(parents=True, exist_ok=True)
    sandbox = _Sandbox(require_isolation=True)
    grade_cache: dict[tuple[str, str], tuple[bool, bool, bool]] = {}
    rows: list[dict[str, Any]] = []

    for sweep_id in sweeps:
        labels = _cell_labels(reader, sweep_id)
        submissions = _manifest_entries(reader, sweep_id)
        results = _results(reader, sweep_id)
        unexpected = set(results) - set(submissions)
        if unexpected:
            raise ValueError(
                f"{sweep_id} has results outside S3 manifests: {sorted(unexpected)[:5]}"
            )
        for shard_id, entry in sorted(submissions.items()):
            instance_id = str(entry["instance_id"])
            cell = entry.get("cell")
            if not isinstance(cell, dict):
                raise ValueError(f"manifest shard {shard_id} has no cell")
            cell_id = str(entry["_cell_id"])
            result = results.get(shard_id)
            raw = result.get("raw") if isinstance(result, dict) else None
            code = str(raw.get("selected_code") or "") if isinstance(raw, dict) else ""
            replay_public = replay_private = replay_pass = None
            if (
                instance_id not in exclusions
                and result is not None
                and result.get("status") != "error"
                and code.strip()
            ):
                problem_key = f"lcb-store/{instance_id}.json"
                problem_bytes = reader.get(problem_key)
                problem = _legacy_problem(json.loads(problem_bytes))
                cache_key = (_sha256(problem_bytes), _sha256(code))
                grade = grade_cache.get(cache_key)
                if grade is None:
                    public_tests, private_tests = decode_tests(problem)
                    public = run_tests(
                        sandbox,
                        code,
                        public_tests,
                        timeout_s=timeout_s,
                        stop_on_failure=True,
                    )
                    private = (
                        run_tests(
                            sandbox,
                            code,
                            private_tests,
                            timeout_s=timeout_s,
                            stop_on_failure=True,
                        )
                        if public["all_passed"]
                        else {"all_passed": False}
                    )
                    grade = (
                        bool(public["all_passed"]),
                        bool(private["all_passed"]),
                        bool(public["all_passed"] and private["all_passed"]),
                    )
                    grade_cache[cache_key] = grade
                replay_public, replay_private, replay_pass = grade
            rows.append(
                {
                    "sweep_id": sweep_id,
                    "cell_id": cell_id,
                    "label": labels.get(cell_id, cell_id),
                    "instance_id": instance_id,
                    "shard_id": shard_id,
                    "result_present": result is not None,
                    "historical_status": result.get("status") if result else None,
                    "historical_pass": bool(result.get("resolved")) if result else False,
                    "replay_public_pass": replay_public,
                    "replay_private_pass": replay_private,
                    "replay_pass": replay_pass,
                    "legacy_oracle_pass": _legacy_oracle(result) if result else None,
                    "excluded": instance_id in exclusions,
                    "attribution": _attribution(
                        excluded=instance_id in exclusions,
                        result=result,
                        code=code,
                        replay_pass=replay_pass,
                    ),
                    "result_s3_key": result.get("_s3_key") if result else None,
                }
            )

    rows.sort(
        key=lambda row: (
            row["sweep_id"],
            row["label"],
            row["instance_id"],
        )
    )
    _write_jsonl(output / "task-attribution.jsonl", rows)

    grouped: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[(row["sweep_id"], row["cell_id"], row["label"])].append(row)
    with (output / "attribution-summary.csv").open("w", newline="") as stream:
        writer = csv.DictWriter(
            stream,
            fieldnames=[
                "sweep_id",
                "cell_id",
                "label",
                "submitted",
                "eligible",
                "terminal",
                "errors",
                "missing",
                "historical_passes",
                "replay_passes",
                "replay_rate",
                "attributions",
            ],
        )
        writer.writeheader()
        for (sweep_id, cell_id, label), group in sorted(grouped.items()):
            eligible = [row for row in group if not row["excluded"]]
            replay_passes = sum(row["replay_pass"] is True for row in eligible)
            writer.writerow(
                {
                    "sweep_id": sweep_id,
                    "cell_id": cell_id,
                    "label": label,
                    "submitted": len(group),
                    "eligible": len(eligible),
                    "terminal": sum(row["result_present"] for row in eligible),
                    "errors": sum(row["historical_status"] == "error" for row in eligible),
                    "missing": sum(not row["result_present"] for row in eligible),
                    "historical_passes": sum(row["historical_pass"] for row in eligible),
                    "replay_passes": replay_passes,
                    "replay_rate": replay_passes / len(eligible) if eligible else "",
                    "attributions": json.dumps(
                        Counter(row["attribution"] for row in eligible),
                        sort_keys=True,
                        separators=(",", ":"),
                    ),
                }
            )
    (output / "input-manifest.json").write_text(
        json.dumps(
            {
                "bucket": reader.bucket,
                "objects": [
                    reader.objects[key]
                    for key in sorted(reader.objects)
                ],
                "runner": "livecodebench-v5-official-28fef95e",
                "exclusions_sha256": _sha256(
                    "\n".join(sorted(exclusions))
                ),
            },
            indent=2,
            sort_keys=True,
        )
    )
    return rows


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bucket", default=DEFAULT_BUCKET)
    parser.add_argument("--sweep", action="append", dest="sweeps")
    parser.add_argument("--out", type=Path, default=Path("/tmp/hypergrid-frozen-replay"))
    parser.add_argument("--test-timeout-s", type=float, default=30.0)
    parser.add_argument(
        "--exclusions",
        type=Path,
        default=Path("analysis/hypergrid/manifests/special_judge_exclusions.txt"),
    )
    args = parser.parse_args()
    rows = replay(
        reader=EvidenceReader(args.bucket),
        sweeps=args.sweeps or DEFAULT_SWEEPS,
        output=args.out,
        exclusions=_exclusions(args.exclusions),
        timeout_s=args.test_timeout_s,
    )
    print(f"wrote {len(rows)} frozen-attribution rows to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
