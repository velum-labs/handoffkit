from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

ChatRole = Literal["system", "user", "assistant", "tool"]


class ToolCall(BaseModel):
    id: str
    name: str
    arguments: str = "{}"


class ChatMessage(BaseModel):
    role: ChatRole
    content: str = ""
    name: str | None = None
    tool_call_id: str | None = None
    tool_calls: list[ToolCall] | None = None

    @field_validator("content", mode="before")
    @classmethod
    def _coerce_content(cls, value: Any) -> Any:
        # OpenAI-shaped conversations (e.g. an agent tool loop) send `content: null`
        # for tool-call-only assistant turns and a parts array for multimodal/agent
        # messages; flatten both to plain text so the message validates.
        if value is None:
            return ""
        if isinstance(value, list):
            parts: list[str] = []
            for part in value:
                if isinstance(part, str):
                    parts.append(part)
                elif isinstance(part, dict) and isinstance(part.get("text"), str):
                    parts.append(part["text"])
            return "".join(parts)
        return value

    @field_validator("tool_calls", mode="before")
    @classmethod
    def _flatten_tool_calls(cls, value: Any) -> Any:
        # Accept OpenAI's nested ({id, type, function:{name, arguments}}) tool-call
        # shape in addition to the flat ({id, name, arguments}) one, so a coding
        # harness's assistant turns parse without a separate normalization pass.
        if not value:
            return value
        flattened: list[Any] = []
        for call in value:
            if isinstance(call, dict) and "function" in call:
                function = call.get("function") or {}
                flattened.append(
                    {
                        "id": call.get("id", ""),
                        "name": function.get("name", ""),
                        "arguments": function.get("arguments", "{}") or "{}",
                    }
                )
            else:
                flattened.append(call)
        return flattened


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
    tool_calls: list[ToolCall] = Field(default_factory=list)
    raw: dict[str, Any] = Field(default_factory=dict)


class StreamChunk(BaseModel):
    delta: str = ""
    tool_call_delta: ToolCall | None = None
    finish_reason: str | None = None
    usage: Usage | None = None


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
