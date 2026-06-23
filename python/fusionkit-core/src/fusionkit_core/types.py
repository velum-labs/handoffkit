from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from fusionkit_core.contracts import Status, SynthesisDecision, TrajectoryItem

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


class TrajectorySynthesis(BaseModel):
    """Fusion result folded onto the consolidated (fused) trajectory.

    Present only on the terminal trajectory ``fuse`` produces. It carries the
    judge/synthesis ``decision`` (``select_trajectory`` when the fused answer
    matched a candidate verbatim, else ``synthesize``), the ``selected_trajectory_id``,
    the ``rationale``, and ``metrics``. This replaces the former standalone
    ``JudgeSynthesisRecord``: the fused output is just a ``Trajectory`` and its
    result is metadata on it, not a separate record.
    """

    decision: SynthesisDecision = "synthesize"
    selected_trajectory_id: str | None = None
    rationale: str | None = None
    score: float | None = None
    input_trajectory_ids: list[str] = Field(default_factory=list)
    metrics: dict[str, Any] = Field(default_factory=dict)


class Trajectory(BaseModel):
    """The canonical fusion unit.

    A trajectory is one attempt at the request. A plain sampled answer is a
    zero-item trajectory (``items == []``); a coding agent's run is a full
    trajectory of reasoning / function_call / function_call_output / message
    items (OpenAI Responses shape). ``content`` is the final output text.
    fusionkit does not own verification, so a trajectory carries no pass/fail
    verdict; any tests a harness ran are just function_call_output items.
    Trajectories flow to the judge in generation order (see
    :class:`fusionkit_core.contracts.TrajectoryV1` for the wire contract).

    ``fuse`` produces a consolidated trajectory whose ``synthesis`` holds the
    fusion result (decision/selected/rationale/metrics); candidate trajectories
    leave it ``None``.
    """

    id: str
    model_id: str
    content: str
    items: list[TrajectoryItem] = Field(default_factory=list)
    status: Status = "succeeded"
    synthesis: TrajectorySynthesis | None = None
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
    trajectories: list[Trajectory] = Field(default_factory=list)
    analysis: FusionAnalysis | None = None
    route: str | None = None
    metrics: dict[str, Any] = Field(default_factory=dict)
