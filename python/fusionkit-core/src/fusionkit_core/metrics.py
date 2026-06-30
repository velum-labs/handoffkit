from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field


class RunRecord(BaseModel):
    id: str
    mode: str
    model_ids: list[str]
    prompt: str
    output: str
    latency_s: float | None = None
    score: float | None = None
    peak_memory_gb: float | None = None
    energy_j: float | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class JsonlRunLogger:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def append(self, record: RunRecord) -> None:
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record.model_dump(mode="json")) + "\n")
