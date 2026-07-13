"""Always-on live hypergrid controller.

S3 ShardResults are the checkpoint/source of truth. This controller reacts to
S3 notifications delivered via SQS (and periodically reconciles all sweeps),
recomputes only derived CellSnapshots, writes them durably to S3, and refreshes
OTel observable gauges consumed by Prometheus/Grafana.

It is stateless and fully resumable: restart it at any time and it rebuilds the
same snapshots from ``runs/<sweep>/cells`` + ``results``.
"""

from __future__ import annotations

import json
import os
import signal
import time
from importlib import import_module
from typing import Any
from urllib.parse import unquote_plus

from hyperkit.backends.s3 import S3ResultStore
from hyperkit.core.models import Cell, ShardResult
from hyperkit.core.snapshots import CellSnapshot, build_cell_snapshots
from hyperkit.telemetry import configure, record_snapshot_deltas, set_cell_snapshots

_stop = False


def _required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def _boto3_client(service: str) -> Any:
    try:
        boto3 = import_module("boto3")
    except ModuleNotFoundError as exc:
        raise RuntimeError("controller requires the 'hyperkit[aws]' extra") from exc
    return boto3.client(service)


class S3SweepRepository:
    def __init__(self, bucket: str, *, prefix: str = "", client: Any | None = None):
        self.store = S3ResultStore(bucket, prefix=prefix, client=client)

    def sweep_ids(self) -> list[str]:
        prefix = self.store._key("runs/")
        ids: set[str] = set()
        for item in self.store._list_objects(prefix):
            parts = item.get("Key", "").split("/")
            if "runs" in parts:
                index = parts.index("runs")
                if len(parts) > index + 1:
                    ids.add(parts[index + 1])
        return sorted(ids)

    def cells(self, sweep_id: str) -> list[tuple[Cell, int]]:
        prefix = self.store._key(f"runs/{sweep_id}/cells/")
        out: list[tuple[Cell, int]] = []
        for item in self.store._list_objects(prefix):
            key = item.get("Key", "")
            if not key.endswith(".json"):
                continue
            response = self.store.client.get_object(Bucket=self.store.bucket, Key=key)
            payload = json.loads(response["Body"].read())
            out.append(
                (
                    Cell.model_validate(payload["cell"]),
                    int(payload.get("generation", 0)),
                )
            )
        return out

    def results(self, sweep_id: str) -> list[ShardResult]:
        return self.store.get_all(sweep_id)

    def put_snapshots(self, sweep_id: str, snapshots: list[CellSnapshot]) -> None:
        for snapshot in snapshots:
            key = self.store._key(
                f"runs/{sweep_id}/snapshots/{snapshot.cell_id}.json"
            )
            self.store.client.put_object(
                Bucket=self.store.bucket,
                Key=key,
                Body=snapshot.model_dump_json(indent=2).encode(),
                ContentType="application/json",
            )


class HypergridController:
    def __init__(self, repository: S3SweepRepository):
        self.repository = repository
        self.snapshots: dict[tuple[str, str], CellSnapshot] = {}

    def reconcile(self, sweep_id: str) -> list[CellSnapshot]:
        cells = self.repository.cells(sweep_id)
        if not cells:
            return []
        snapshots = build_cell_snapshots(
            sweep_id,
            cells,
            self.repository.results(sweep_id),
        )
        self.repository.put_snapshots(sweep_id, snapshots)
        previous = [
            snapshot
            for (stored_sweep_id, _), snapshot in self.snapshots.items()
            if stored_sweep_id == sweep_id
        ]
        record_snapshot_deltas(previous, snapshots)
        for snapshot in snapshots:
            self.snapshots[(sweep_id, snapshot.cell_id)] = snapshot
        set_cell_snapshots(list(self.snapshots.values()))
        return snapshots

    def reconcile_all(self, only_sweep: str | None = None) -> int:
        sweep_ids = [only_sweep] if only_sweep else self.repository.sweep_ids()
        return sum(len(self.reconcile(sweep_id)) for sweep_id in sweep_ids)


def _sweep_ids_from_message(body: str) -> set[str]:
    """Extract sweep ids from an S3 event (handles SQS->S3 and SNS envelope)."""

    message = json.loads(body)
    if "Message" in message:
        message = json.loads(message["Message"])
    ids: set[str] = set()
    for record in message.get("Records", []):
        key = unquote_plus(record.get("s3", {}).get("object", {}).get("key", ""))
        parts = key.split("/")
        if "runs" in parts:
            index = parts.index("runs")
            if len(parts) > index + 1:
                ids.add(parts[index + 1])
    return ids


def run_loop(
    controller: HypergridController,
    *,
    sqs_client: Any | None,
    queue_url: str | None,
    poll_interval: float,
    only_sweep: str | None,
) -> None:
    last_reconcile = 0.0
    while not _stop:
        now = time.monotonic()
        if now - last_reconcile >= poll_interval:
            controller.reconcile_all(only_sweep)
            last_reconcile = now

        if sqs_client is None or queue_url is None:
            time.sleep(min(poll_interval, 5.0))
            continue

        response = sqs_client.receive_message(
            QueueUrl=queue_url,
            MaxNumberOfMessages=10,
            WaitTimeSeconds=20,
            VisibilityTimeout=120,
        )
        for message in response.get("Messages", []):
            for sweep_id in _sweep_ids_from_message(message["Body"]):
                if only_sweep is None or sweep_id == only_sweep:
                    controller.reconcile(sweep_id)
            sqs_client.delete_message(
                QueueUrl=queue_url,
                ReceiptHandle=message["ReceiptHandle"],
            )


def _stop_handler(_signum: int, _frame: object) -> None:
    global _stop
    _stop = True


def main() -> int:
    bucket = _required_env("HYPERKIT_S3_BUCKET")
    prefix = os.environ.get("HYPERKIT_S3_PREFIX", "")
    queue_url = os.environ.get("HYPERKIT_SQS_QUEUE_URL")
    only_sweep = os.environ.get("HYPERKIT_SWEEP_ID")
    poll_interval = float(os.environ.get("HYPERKIT_POLL_INTERVAL", "30"))

    configure("hyperkit-controller")
    s3_client = _boto3_client("s3")
    sqs_client = _boto3_client("sqs") if queue_url else None
    controller = HypergridController(
        S3SweepRepository(bucket, prefix=prefix, client=s3_client)
    )
    signal.signal(signal.SIGTERM, _stop_handler)
    signal.signal(signal.SIGINT, _stop_handler)
    controller.reconcile_all(only_sweep)
    run_loop(
        controller,
        sqs_client=sqs_client,
        queue_url=queue_url,
        poll_interval=poll_interval,
        only_sweep=only_sweep,
    )
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())

