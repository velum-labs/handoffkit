from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

ChatRole = Literal["system", "user", "assistant", "tool"]


class ChatMessage(BaseModel):
    role: ChatRole
    content: str


class Usage(BaseModel):
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    total_tokens: int | None = None


class CallMetrics(BaseModel):
    model_id: str
    latency_s: float
    usage: Usage = Field(default_factory=Usage)
    request_id: str | None = None


class ModelResponse(BaseModel):
    model_id: str
    content: str
    finish_reason: str | None = None
    usage: Usage = Field(default_factory=Usage)
    latency_s: float = 0.0
    raw: dict[str, Any] = Field(default_factory=dict)


class Candidate(BaseModel):
    id: str
    model_id: str
    content: str
    rank: int | None = None
    score: float | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class FusionAnalysis(BaseModel):
    consensus: list[str] = Field(default_factory=list)
    contradictions: list[str] = Field(default_factory=list)
    unique_insights: list[str] = Field(default_factory=list)
    coverage_gaps: list[str] = Field(default_factory=list)
    likely_errors: list[str] = Field(default_factory=list)
    recommended_final_structure: list[str] = Field(default_factory=list)


class FusionResult(BaseModel):
    mode: str
    content: str
    candidates: list[Candidate] = Field(default_factory=list)
    analysis: FusionAnalysis | None = None
    route: str | None = None
    metrics: dict[str, Any] = Field(default_factory=dict)
