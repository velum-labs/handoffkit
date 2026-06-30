"""Append-only ledger of benchmark runs for regression tracking.

Stores one JSON record per run so drift can be detected over time (today's score
vs the last comparable run for the same suite + panel). Intended to back a cheap
always-on CI subset gate plus periodic full runs.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path

from pydantic import BaseModel, Field


class BenchRunRecord(BaseModel):
    suite: str
    panel_id: str
    recorded_at: str = Field(default_factory=lambda: datetime.now(UTC).isoformat())
    resolved_tasks: int = 0
    score: float | None = None
    ci_low: float | None = None
    ci_high: float | None = None
    cache_signature: str | None = None
    repo_sha: str | None = None
    notes: str = ""


class BenchDrift(BaseModel):
    suite: str
    panel_id: str
    current_score: float
    previous_score: float
    delta: float
    previous_recorded_at: str
    regressed: bool


def append_run(ledger_path: str | Path, record: BenchRunRecord) -> None:
    path = Path(ledger_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record.model_dump(mode="json")) + "\n")


def load_runs(ledger_path: str | Path) -> list[BenchRunRecord]:
    path = Path(ledger_path)
    if not path.exists():
        return []
    records = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            records.append(BenchRunRecord.model_validate_json(line))
    return records


def previous_comparable(
    runs: Iterable[BenchRunRecord],
    *,
    suite: str,
    panel_id: str,
) -> BenchRunRecord | None:
    matches = [
        run
        for run in runs
        if run.suite == suite and run.panel_id == panel_id and run.score is not None
    ]
    return matches[-1] if matches else None


def drift_vs_previous(
    ledger_path: str | Path,
    current: BenchRunRecord,
    *,
    regression_threshold: float = 0.02,
) -> BenchDrift | None:
    if current.score is None:
        return None
    previous = previous_comparable(
        load_runs(ledger_path), suite=current.suite, panel_id=current.panel_id
    )
    if previous is None or previous.score is None:
        return None
    delta = current.score - previous.score
    return BenchDrift(
        suite=current.suite,
        panel_id=current.panel_id,
        current_score=current.score,
        previous_score=previous.score,
        delta=delta,
        previous_recorded_at=previous.recorded_at,
        regressed=delta < -regression_threshold,
    )


__all__ = [
    "BenchDrift",
    "BenchRunRecord",
    "append_run",
    "drift_vs_previous",
    "load_runs",
    "previous_comparable",
]
