"""Pydantic models and type aliases for fusion runs.

Split out of :mod:`fusionkit_core.run` so the run data schema is separated from
the (large) :class:`~fusionkit_core.run.FusionRunManager` state machine. The
models are re-exported from ``run`` for backwards compatibility.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field

from fusionkit_core.contracts import (
    ArtifactKind,
    ContractArtifactRef,
    ContractError,
    ErrorKind,
    FusionRunState,
    Owner,
    Sha256,
    SideEffects,
    Status,
    ToolCallPlanV1,
)

IdempotencyOutcome = Literal["created", "replayed", "conflict"]
ToolExecutionMode = Literal["disabled", "external", "executor"]
RunEventType = Literal[
    "run_queued",
    "state_changed",
    "trajectory_recorded",
    "model_call_recorded",
    "artifact_recorded",
    "judge_synthesis_recorded",
    "tool_call_planned",
    "tool_execution_recorded",
    "run_resumed",
    "fusion_recorded",
    "error_recorded",
    "requires_action",
]


class RunBaseModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class NativeRunError(RunBaseModel):
    error_kind: ErrorKind
    error_code: str
    retryable: bool
    owner: Owner
    terminal_reason: str
    message: str | None = None


class ToolExecutionPolicy(RunBaseModel):
    mode: ToolExecutionMode = "disabled"
    allowed_side_effects: list[SideEffects] = Field(default_factory=lambda: ["read_only"])
    environment: str | None = None
    policy_id: str | None = None
    dedupe_read_only: bool = True
    executor_configured: bool = False


class ToolPausePlaceholder(RunBaseModel):
    trajectory_id: str
    tool_call_id: str
    plan: ToolCallPlanV1 | None = None
    policy_cache_key: str | None = None


class ToolResultSubmission(RunBaseModel):
    trajectory_id: str
    tool_call_id: str
    tool_name: str
    output_hash: Sha256 | None = None
    output: str | None = None
    status: Status = "succeeded"
    error: ContractError | None = None


class FusionRunEvent(RunBaseModel):
    event_seq: int = Field(ge=1)
    run_id: str
    trace_id: str
    state: FusionRunState
    status: Status
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    event_type: RunEventType
    trajectory_id: str | None = None
    model_call_id: str | None = None
    artifact_id: str | None = None
    tool_call_id: str | None = None
    idempotency_key: str | None = None
    request_hash: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)


class IdempotencyRecord(RunBaseModel):
    idempotency_key: str
    request_hash: str
    run_id: str
    trace_id: str


class CreateRunResult(RunBaseModel):
    run_id: str | None
    trace_id: str | None
    state: FusionRunState | None
    status: Status | None
    event_cursor: int | None
    idempotency_outcome: IdempotencyOutcome
    terminal_error: NativeRunError | None = None


class RunStateSummary(RunBaseModel):
    run_id: str
    trace_id: str
    state: FusionRunState
    status: Status
    event_cursor: int
    idempotency_key: str | None = None
    request_hash: str | None = None
    terminal_error: NativeRunError | None = None
    terminal_reason: str | None = None
    final_output: str | None = None


class TrajectoryInspection(RunBaseModel):
    trajectory_id: str
    model_id: str
    source_trajectory_id: str | None = None
    model_call_id: str | None = None
    artifact: ContractArtifactRef | None = None


class RunInspection(RunBaseModel):
    run_id: str
    trace_id: str
    state: FusionRunState
    status: Status
    event_cursor: int
    trajectories: list[TrajectoryInspection] = Field(default_factory=list)
    artifacts: list[ContractArtifactRef] = Field(default_factory=list)
    model_call_ids: list[str] = Field(default_factory=list)
    final_output: str | None = None
    final_output_artifact: ContractArtifactRef | None = None
    judge_synthesis_record: dict[str, Any] | None = None
    requires_action: ToolPausePlaceholder | None = None
    terminal_error: NativeRunError | None = None
    provider_metadata: list[dict[str, Any]] = Field(default_factory=list)


class RunEventPage(RunBaseModel):
    run_id: str
    events: list[FusionRunEvent]
    next_event_cursor: int | None


class RunStore(Protocol):
    def get_idempotency(self, idempotency_key: str) -> IdempotencyRecord | None: ...

    def write_idempotency(self, record: IdempotencyRecord) -> None: ...

    def append_event(self, event: FusionRunEvent) -> FusionRunEvent: ...

    def list_events(self, run_id: str, after: int | None = None) -> list[FusionRunEvent]: ...

    def event_page(self, run_id: str, after: int | None = None) -> RunEventPage: ...

    def read_summary(self, run_id: str) -> RunStateSummary: ...

    def write_summary(self, summary: RunStateSummary) -> None: ...

    def inspect_run(self, run_id: str) -> RunInspection: ...


class ArtifactWriter(Protocol):
    def write_text(
        self,
        run_id: str,
        artifact_id: str,
        kind: ArtifactKind,
        content: str,
        *,
        suffix: str = ".txt",
    ) -> ContractArtifactRef: ...
