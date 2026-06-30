from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class EvalSample(BaseModel):
    id: str
    prompt: str
    expected: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class EvalResult(BaseModel):
    sample_id: str
    config_id: str
    mode: str
    output: str
    score: float | None = None
    latency_s: float | None = None
    peak_memory_gb: float | None = None
    energy_j: float | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
