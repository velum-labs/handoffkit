from __future__ import annotations

import json
import uuid
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field

from fusionkit_core.artifacts import hash_text
from fusionkit_core.config import SamplingConfig
from fusionkit_core.contracts import (
    ArtifactKind,
    ContractArtifactRef,
    ContractError,
    ErrorKind,
    FusionMode,
    FusionRecordV1,
    FusionRunRequestV1,
    FusionRunState,
    ModelCallRecordV1,
    Owner,
    Sha256,
    SideEffects,
    Status,
    ToolCallPlanV1,
    ToolExecutionRecordV1,
    contract_metadata,
    status_for_run_state,
)
from fusionkit_core.fusion import FusionEngine
from fusionkit_core.types import Candidate, ChatMessage, FusionAnalysis

IdempotencyOutcome = Literal["created", "replayed", "conflict"]
ToolExecutionMode = Literal["disabled", "external", "executor"]
RunEventType = Literal[
    "run_queued",
    "state_changed",
    "candidate_recorded",
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
    candidate_id: str
    tool_call_id: str
    plan: ToolCallPlanV1 | None = None
    policy_cache_key: str | None = None


class ToolResultSubmission(RunBaseModel):
    candidate_id: str
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
    candidate_id: str | None = None
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


class CandidateInspection(RunBaseModel):
    candidate_id: str
    model_id: str
    source_candidate_id: str | None = None
    model_call_id: str | None = None
    artifact: ContractArtifactRef | None = None
    score: float | None = None
    rank: int | None = None


class RunInspection(RunBaseModel):
    run_id: str
    trace_id: str
    state: FusionRunState
    status: Status
    event_cursor: int
    candidates: list[CandidateInspection] = Field(default_factory=list)
    artifacts: list[ContractArtifactRef] = Field(default_factory=list)
    model_call_ids: list[str] = Field(default_factory=list)
    final_output: str | None = None
    final_output_artifact: ContractArtifactRef | None = None
    judge_synthesis_record: dict[str, Any] | None = None
    requires_action: ToolPausePlaceholder | None = None
    terminal_error: NativeRunError | None = None


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


class FusionRunManager:
    def __init__(
        self,
        engine: FusionEngine,
        store: RunStore,
        artifacts: ArtifactWriter,
    ) -> None:
        self.engine = engine
        self.store = store
        self.artifacts = artifacts

    def create_run(
        self,
        request: FusionRunRequestV1,
        *,
        idempotency_key: str | None = None,
    ) -> CreateRunResult:
        request_hash = hash_json(request.model_dump(mode="json"))
        if idempotency_key is not None:
            existing = self.store.get_idempotency(idempotency_key)
            if existing is not None:
                if existing.request_hash == request_hash:
                    summary = self.store.read_summary(existing.run_id)
                    return CreateRunResult(
                        run_id=existing.run_id,
                        trace_id=existing.trace_id,
                        state=summary.state,
                        status=summary.status,
                        event_cursor=summary.event_cursor,
                        idempotency_outcome="replayed",
                        terminal_error=summary.terminal_error,
                    )
                return CreateRunResult(
                    run_id=existing.run_id,
                    trace_id=existing.trace_id,
                    state=None,
                    status=None,
                    event_cursor=None,
                    idempotency_outcome="conflict",
                    terminal_error=NativeRunError(
                        error_kind="validation_error",
                        error_code="idempotency_conflict",
                        retryable=False,
                        owner="fusionkit",
                        terminal_reason="idempotency_key_reused_with_different_request",
                    ),
                )

        run_id = make_id("run")
        trace_id = make_id("trace")
        if idempotency_key is not None:
            self.store.write_idempotency(
                IdempotencyRecord(
                    idempotency_key=idempotency_key,
                    request_hash=request_hash,
                    run_id=run_id,
                    trace_id=trace_id,
                )
            )

        event = self.store.append_event(
            FusionRunEvent(
                event_seq=1,
                run_id=run_id,
                trace_id=trace_id,
                state="queued",
                status=status_for_run_state("queued"),
                event_type="run_queued",
                idempotency_key=idempotency_key,
                request_hash=request_hash,
                payload={"request": request.model_dump(mode="json")},
            )
        )
        self.store.write_summary(
            RunStateSummary(
                run_id=run_id,
                trace_id=trace_id,
                state="queued",
                status=status_for_run_state("queued"),
                event_cursor=event.event_seq,
                idempotency_key=idempotency_key,
                request_hash=request_hash,
            )
        )
        return CreateRunResult(
            run_id=run_id,
            trace_id=trace_id,
            state="queued",
            status=status_for_run_state("queued"),
            event_cursor=event.event_seq,
            idempotency_outcome="created",
        )

    async def create_and_run(
        self,
        request: FusionRunRequestV1,
        *,
        idempotency_key: str | None = None,
    ) -> RunInspection | CreateRunResult:
        created = self.create_run(request, idempotency_key=idempotency_key)
        if created.idempotency_outcome != "created":
            return created
        if created.run_id is None:
            return created
        return await self.execute_run(created.run_id)

    async def execute_run(self, run_id: str) -> RunInspection:
        summary = self.store.read_summary(run_id)
        if summary.state in ("cancelled", "completed", "failed", "expired"):
            return self.store.inspect_run(run_id)

        events = self.store.list_events(run_id)
        request = _request_from_events(events)
        self._append_state(summary, "generating")
        try:
            selected_mode: FusionMode = request.mode
            if selected_mode == "router":
                decision = self.engine.router.route(_runtime_messages(request.messages))
                selected_mode = decision.route

            sampling = _sampling_from_request(request)
            candidates = await self._generate_candidates(request, selected_mode, sampling)
            if selected_mode != "single":
                candidates = self.engine.ranker.rank(candidates)
            candidate_infos, model_call_ids, candidate_artifacts = self._record_candidates(
                run_id,
                summary.trace_id,
                request,
                candidates,
            )

            analysis: FusionAnalysis | None = None
            answer: str
            synthesis_record = None
            selected_candidate_id = (
                candidate_infos[0].candidate_id if candidate_infos else None
            )
            if selected_mode == "single":
                answer = candidates[0].content if candidates else ""
            else:
                selected_candidate_id = _candidate_id_for_source(candidate_infos, candidates[0].id)
                self._append_state(summary, "judging")
                self._append_state(summary, "synthesizing")
                synthesis = await self.engine._judge_synthesize(
                    _runtime_messages(request.messages),
                    candidates,
                )
                answer = synthesis.final_output
                analysis = synthesis.analysis
                synthesis_record = synthesis.record

            verification_artifact: ContractArtifactRef | None = None
            if request.verify:
                self._append_state(summary, "verifying")
                answer = await self.engine._verify(
                    _runtime_messages(request.messages),
                    answer,
                    candidates,
                )
                if synthesis_record is not None:
                    synthesis_record = synthesis_record.model_copy(
                        update={
                            "final_output": answer,
                            "metrics": {
                                **(synthesis_record.metrics or {}),
                                "repair_attempted": True,
                                "repair_rounds": 1,
                                "repair_reason": "verify_requested",
                            },
                        }
                    )
                verification_artifact = self.artifacts.write_text(
                    run_id,
                    make_id("artifact_verification"),
                    "metrics",
                    answer,
                )
                self._append_artifact_event(
                    run_id,
                    summary.trace_id,
                    "verifying",
                    verification_artifact,
                )

            final_artifact = self.artifacts.write_text(
                run_id,
                make_id("artifact_final"),
                "transcript",
                answer,
            )
            self._append_artifact_event(run_id, summary.trace_id, "synthesizing", final_artifact)
            artifacts = [*candidate_artifacts, final_artifact]
            if verification_artifact is not None:
                artifacts.append(verification_artifact)
            if synthesis_record is not None:
                synthesis_record = synthesis_record.model_copy(
                    update={
                        "metrics": {
                            **(synthesis_record.metrics or {}),
                            "final_output_artifact_id": final_artifact.artifact_id,
                        }
                    }
                )
                self.store.append_event(
                    FusionRunEvent(
                        event_seq=1,
                        run_id=run_id,
                        trace_id=summary.trace_id,
                        state="synthesizing",
                        status=status_for_run_state("synthesizing"),
                        event_type="judge_synthesis_recorded",
                        payload={
                            "judge_synthesis_record": synthesis_record.model_dump(mode="json")
                        },
                    )
                )

            fusion_record = FusionRecordV1.model_validate(
                {
                    **contract_metadata("fusion-record.v1"),
                    "run_id": run_id,
                    "request_id": request.request_id,
                    "mode": selected_mode,
                    "status": "succeeded",
                    "candidate_ids": [candidate.candidate_id for candidate in candidate_infos],
                    "model_call_ids": model_call_ids,
                    "selected_candidate_id": selected_candidate_id,
                    "synthesis_record_id": (
                        synthesis_record.synthesis_id if synthesis_record is not None else None
                    ),
                    "final_output": answer,
                    "started_at": summary.event_cursor and events[0].created_at,
                    "finished_at": datetime.now(UTC),
                    "metrics": _run_metrics(candidates, selected_mode, analysis),
                    "artifacts": [artifact.model_dump(mode="json") for artifact in artifacts],
                }
            )
            event = self.store.append_event(
                FusionRunEvent(
                    event_seq=1,
                    run_id=run_id,
                    trace_id=summary.trace_id,
                    state="completed",
                    status=status_for_run_state("completed"),
                    event_type="fusion_recorded",
                    payload={"fusion_record": fusion_record.model_dump(mode="json")},
                )
            )
            self.store.write_summary(
                RunStateSummary(
                    run_id=run_id,
                    trace_id=summary.trace_id,
                    state="completed",
                    status=status_for_run_state("completed"),
                    event_cursor=event.event_seq,
                    idempotency_key=summary.idempotency_key,
                    request_hash=summary.request_hash,
                    final_output=answer,
                )
            )
            return self.store.inspect_run(run_id)
        except Exception as exc:
            error = NativeRunError(
                error_kind="internal_error",
                error_code=exc.__class__.__name__,
                retryable=False,
                owner="fusionkit",
                terminal_reason="run_execution_failed",
                message=str(exc),
            )
            event = self.store.append_event(
                FusionRunEvent(
                    event_seq=1,
                    run_id=run_id,
                    trace_id=summary.trace_id,
                    state="failed",
                    status=status_for_run_state("failed"),
                    event_type="error_recorded",
                    payload={"error": error.model_dump(mode="json")},
                )
            )
            self.store.write_summary(
                RunStateSummary(
                    run_id=run_id,
                    trace_id=summary.trace_id,
                    state="failed",
                    status=status_for_run_state("failed"),
                    event_cursor=event.event_seq,
                    idempotency_key=summary.idempotency_key,
                    request_hash=summary.request_hash,
                    terminal_error=error,
                    terminal_reason=error.terminal_reason,
                )
            )
            return self.store.inspect_run(run_id)

    def cancel_run(self, run_id: str, *, reason: str = "cancelled_by_caller") -> RunStateSummary:
        summary = self.store.read_summary(run_id)
        error = NativeRunError(
            error_kind="none",
            error_code="cancelled",
            retryable=False,
            owner="fusionkit",
            terminal_reason=reason,
        )
        event = self.store.append_event(
            FusionRunEvent(
                event_seq=1,
                run_id=run_id,
                trace_id=summary.trace_id,
                state="cancelled",
                status=status_for_run_state("cancelled"),
                event_type="state_changed",
                payload={"terminal_reason": reason},
            )
        )
        cancelled = summary.model_copy(
            update={
                "state": "cancelled",
                "status": status_for_run_state("cancelled"),
                "event_cursor": event.event_seq,
                "terminal_error": error,
                "terminal_reason": reason,
            }
        )
        self.store.write_summary(cancelled)
        return cancelled

    def record_requires_action(
        self,
        run_id: str,
        *,
        candidate_id: str,
        tool_call_id: str | None = None,
        plan: Mapping[str, Any] | None = None,
    ) -> ToolPausePlaceholder:
        tool_plan = None
        if plan is not None and {"schema", "schema_version", "schema_bundle_hash"}.issubset(plan):
            tool_plan = ToolCallPlanV1.model_validate(plan)
        elif plan is not None:
            tool_plan = self._tool_call_plan(
                tool_name=str(plan.get("tool_name") or "external_tool"),
                arguments=plan,
                side_effects="read_only",
                policy=ToolExecutionPolicy(mode="external"),
                plan_id=str(plan.get("plan_id")) if plan.get("plan_id") is not None else None,
            )
        return self._pause_for_tool_action(
            run_id,
            candidate_id=candidate_id,
            tool_call_id=tool_call_id,
            plan=tool_plan,
            policy_cache_key=None,
        )

    def request_tool_action(
        self,
        run_id: str,
        *,
        candidate_id: str,
        tool_name: str,
        arguments: Mapping[str, Any] | None = None,
        side_effects: SideEffects = "read_only",
        policy: ToolExecutionPolicy | None = None,
    ) -> ToolPausePlaceholder | NativeRunError:
        resolved_policy = policy or ToolExecutionPolicy()
        policy_error = _validate_tool_policy(side_effects, resolved_policy)
        if policy_error is not None:
            return policy_error
        plan = self._tool_call_plan(
            tool_name=tool_name,
            arguments=arguments or {},
            side_effects=side_effects,
            policy=resolved_policy,
        )
        policy_cache_key = _policy_cache_key(
            tool_name=tool_name,
            arguments_hash=plan.arguments_hash,
            side_effects=side_effects,
            policy=resolved_policy,
        )
        summary = self.store.read_summary(run_id)
        tool_call_id = make_id("tool_call")
        self.store.append_event(
            FusionRunEvent(
                event_seq=1,
                run_id=run_id,
                trace_id=summary.trace_id,
                state=summary.state,
                status=summary.status,
                event_type="tool_call_planned",
                candidate_id=candidate_id,
                tool_call_id=tool_call_id,
                payload={
                    "tool_call_plan": plan.model_dump(mode="json"),
                    "policy_cache_key": policy_cache_key,
                },
            )
        )
        return self._pause_for_tool_action(
            run_id,
            candidate_id=candidate_id,
            tool_call_id=tool_call_id,
            plan=plan,
            policy_cache_key=policy_cache_key,
        )

    def submit_tool_result(
        self,
        run_id: str,
        submission: ToolResultSubmission,
    ) -> RunInspection | NativeRunError:
        summary = self.store.read_summary(run_id)
        pending_actions = _pending_tool_actions_from_events(self.store.list_events(run_id))
        if summary.state != "requires_action" or not pending_actions:
            return NativeRunError(
                error_kind="validation_error",
                error_code="run_not_waiting_for_tool",
                retryable=False,
                owner="fusionkit",
                terminal_reason="run_not_in_requires_action",
            )
        pending = pending_actions.get(submission.tool_call_id)
        if pending is None:
            return NativeRunError(
                error_kind="validation_error",
                error_code="tool_call_mismatch",
                retryable=False,
                owner="fusionkit",
                terminal_reason="tool_result_for_wrong_tool_call",
            )
        if pending.candidate_id != submission.candidate_id:
            return NativeRunError(
                error_kind="validation_error",
                error_code="tool_candidate_mismatch",
                retryable=False,
                owner="fusionkit",
                terminal_reason="tool_result_for_wrong_candidate",
            )
        if pending.plan is not None and pending.plan.tool_name != submission.tool_name:
            return NativeRunError(
                error_kind="validation_error",
                error_code="tool_name_mismatch",
                retryable=False,
                owner="fusionkit",
                terminal_reason="tool_result_for_wrong_tool_name",
            )
        output_hash = submission.output_hash or hash_text(submission.output or "")
        plan_id = pending.plan.plan_id if pending.plan is not None else submission.tool_call_id
        execution_record = ToolExecutionRecordV1.model_validate(
            {
                **contract_metadata("tool-execution-record.v1"),
                "execution_id": make_id("tool_execution"),
                "plan_id": plan_id,
                "status": submission.status,
                "output_hash": output_hash,
                "error": submission.error.model_dump(mode="json") if submission.error else None,
            }
        )
        self.store.append_event(
            FusionRunEvent(
                event_seq=1,
                run_id=run_id,
                trace_id=summary.trace_id,
                state="requires_action",
                status=status_for_run_state("requires_action"),
                event_type="tool_execution_recorded",
                candidate_id=submission.candidate_id,
                tool_call_id=submission.tool_call_id,
                payload={"tool_execution_record": execution_record.model_dump(mode="json")},
            )
        )
        remaining_pending = len(pending_actions) - 1
        resumed_state: FusionRunState = "requires_action" if remaining_pending else "generating"
        event = self.store.append_event(
            FusionRunEvent(
                event_seq=1,
                run_id=run_id,
                trace_id=summary.trace_id,
                state=resumed_state,
                status=status_for_run_state(resumed_state),
                event_type="run_resumed",
                candidate_id=submission.candidate_id,
                tool_call_id=submission.tool_call_id,
                payload={
                    "resumed_candidate_id": submission.candidate_id,
                    "remaining_pending_tool_calls": remaining_pending,
                },
            )
        )
        self.store.write_summary(
            summary.model_copy(
                update={
                    "state": resumed_state,
                    "status": status_for_run_state(resumed_state),
                    "event_cursor": event.event_seq,
                }
            )
        )
        return self.store.inspect_run(run_id)

    def _pause_for_tool_action(
        self,
        run_id: str,
        *,
        candidate_id: str,
        tool_call_id: str | None,
        plan: ToolCallPlanV1 | None,
        policy_cache_key: str | None,
    ) -> ToolPausePlaceholder:
        summary = self.store.read_summary(run_id)
        pause = ToolPausePlaceholder(
            candidate_id=candidate_id,
            tool_call_id=tool_call_id or make_id("tool_call"),
            plan=plan,
            policy_cache_key=policy_cache_key,
        )
        event = self.store.append_event(
            FusionRunEvent(
                event_seq=1,
                run_id=run_id,
                trace_id=summary.trace_id,
                state="requires_action",
                status=status_for_run_state("requires_action"),
                event_type="requires_action",
                candidate_id=candidate_id,
                tool_call_id=pause.tool_call_id,
                payload={"requires_action": pause.model_dump(mode="json")},
            )
        )
        self.store.write_summary(
            summary.model_copy(
                update={
                    "state": "requires_action",
                    "status": status_for_run_state("requires_action"),
                    "event_cursor": event.event_seq,
                }
            )
        )
        return pause

    def _tool_call_plan(
        self,
        *,
        tool_name: str,
        arguments: Mapping[str, Any],
        side_effects: SideEffects,
        policy: ToolExecutionPolicy,
        plan_id: str | None = None,
    ) -> ToolCallPlanV1:
        del policy
        return ToolCallPlanV1.model_validate(
            {
                **contract_metadata("tool-call-plan.v1"),
                "plan_id": plan_id or make_id("tool_plan"),
                "tool_name": tool_name,
                "arguments_hash": hash_json(arguments),
                "side_effects": side_effects,
                "status": "requires_action",
            }
        )

    async def _generate_candidates(
        self,
        request: FusionRunRequestV1,
        selected_mode: FusionMode,
        sampling: SamplingConfig,
    ) -> list[Candidate]:
        messages = _runtime_messages(request.messages)
        if selected_mode == "single":
            return [
                await self.engine.panel_runner.generate_single(
                    self.engine.config.default_model,
                    messages,
                    sampling,
                )
            ]
        return await self.engine._generate_candidates(
            mode=selected_mode,
            messages=messages,
            sampling=sampling,
            panel_models=request.requested_models,
            sample_count=request.sample_count,
        )

    def _record_candidates(
        self,
        run_id: str,
        trace_id: str,
        request: FusionRunRequestV1,
        candidates: Sequence[Candidate],
    ) -> tuple[list[CandidateInspection], list[str], list[ContractArtifactRef]]:
        candidate_infos = []
        model_call_ids = []
        artifacts = []
        for index, candidate in enumerate(candidates):
            candidate_id = make_id("candidate")
            model_call_id = make_id("model_call")
            artifact = self.artifacts.write_text(
                run_id,
                make_id("artifact_candidate"),
                "transcript",
                candidate.content,
            )
            artifacts.append(artifact)
            model_call = _model_call_record(
                request=request,
                candidate=candidate,
                model_call_id=model_call_id,
            )
            self.store.append_event(
                FusionRunEvent(
                    event_seq=1,
                    run_id=run_id,
                    trace_id=trace_id,
                    state="generating",
                    status=status_for_run_state("generating"),
                    event_type="model_call_recorded",
                    candidate_id=candidate_id,
                    model_call_id=model_call_id,
                    payload={"model_call_record": model_call.model_dump(mode="json")},
                )
            )
            self.store.append_event(
                FusionRunEvent(
                    event_seq=1,
                    run_id=run_id,
                    trace_id=trace_id,
                    state="generating",
                    status=status_for_run_state("generating"),
                    event_type="candidate_recorded",
                    candidate_id=candidate_id,
                    model_call_id=model_call_id,
                    artifact_id=artifact.artifact_id,
                    payload={
                        "candidate": {
                            "candidate_id": candidate_id,
                            "source_candidate_id": candidate.id,
                            "model_id": candidate.model_id,
                            "rank": candidate.rank,
                            "score": candidate.score,
                            "artifact": artifact.model_dump(mode="json"),
                            "ordinal": index,
                        }
                    },
                )
            )
            candidate_infos.append(
                CandidateInspection(
                    candidate_id=candidate_id,
                    model_id=candidate.model_id,
                    source_candidate_id=candidate.id,
                    model_call_id=model_call_id,
                    artifact=artifact,
                    score=candidate.score,
                    rank=candidate.rank,
                )
            )
            model_call_ids.append(model_call_id)
        return candidate_infos, model_call_ids, artifacts

    def _append_state(self, summary: RunStateSummary, state: FusionRunState) -> FusionRunEvent:
        event = self.store.append_event(
            FusionRunEvent(
                event_seq=1,
                run_id=summary.run_id,
                trace_id=summary.trace_id,
                state=state,
                status=status_for_run_state(state),
                event_type="state_changed",
            )
        )
        self.store.write_summary(
            summary.model_copy(
                update={
                    "state": state,
                    "status": status_for_run_state(state),
                    "event_cursor": event.event_seq,
                }
            )
        )
        return event

    def _append_artifact_event(
        self,
        run_id: str,
        trace_id: str,
        state: FusionRunState,
        artifact: ContractArtifactRef,
    ) -> None:
        self.store.append_event(
            FusionRunEvent(
                event_seq=1,
                run_id=run_id,
                trace_id=trace_id,
                state=state,
                status=status_for_run_state(state),
                event_type="artifact_recorded",
                artifact_id=artifact.artifact_id,
                payload={"artifact": artifact.model_dump(mode="json")},
            )
        )


def make_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def hash_json(value: Any) -> str:
    return hash_text(canonical_json(value))


def _request_from_events(events: Sequence[FusionRunEvent]) -> FusionRunRequestV1:
    for event in events:
        if event.event_type == "run_queued":
            return FusionRunRequestV1.model_validate(event.payload["request"])
    raise ValueError("Run does not have a queued request event")


def _runtime_messages(messages: Sequence[Any]) -> list[ChatMessage]:
    normalized = []
    for message in messages:
        if isinstance(message, ChatMessage):
            normalized.append(message)
        elif isinstance(message, BaseModel):
            normalized.append(ChatMessage.model_validate(message.model_dump(mode="json")))
        else:
            normalized.append(ChatMessage.model_validate(message))
    return normalized


def _sampling_from_request(request: FusionRunRequestV1) -> SamplingConfig:
    updates = {
        key: value
        for key, value in request.sampling.model_dump().items()
        if value is not None
    }
    return SamplingConfig().model_copy(update=updates)


def _model_call_record(
    *,
    request: FusionRunRequestV1,
    candidate: Candidate,
    model_call_id: str,
) -> ModelCallRecordV1:
    latency_s = candidate.metadata.get("latency_s")
    usage = candidate.metadata.get("usage")
    latency_ms = latency_s * 1000 if isinstance(latency_s, int | float) else None
    return ModelCallRecordV1.model_validate(
        {
            **contract_metadata("model-call-record.v1"),
            "call_id": model_call_id,
            "endpoint_id": candidate.model_id,
            "model": candidate.model_id,
            "request_hash": hash_json(
                {
                    "request_id": request.request_id,
                    "model_id": candidate.model_id,
                    "messages": [message.model_dump(mode="json") for message in request.messages],
                }
            ),
            "response_hash": hash_text(candidate.content),
            "status": "succeeded",
            "messages": [message.model_dump(mode="json") for message in request.messages],
            "side_effects": "none",
            "started_at": datetime.now(UTC),
            "finished_at": datetime.now(UTC),
            "latency_ms": latency_ms,
            "usage": usage if isinstance(usage, dict) else None,
            "metadata": {
                "finish_reason": candidate.metadata.get("finish_reason"),
                "unknown_cost": None,
            },
        }
    )


def _pending_tool_actions_from_events(
    events: Sequence[FusionRunEvent],
) -> dict[str, ToolPausePlaceholder]:
    pending: dict[str, ToolPausePlaceholder] = {}
    for event in events:
        if event.event_type == "requires_action":
            payload = event.payload.get("requires_action")
            if isinstance(payload, dict):
                pause = ToolPausePlaceholder.model_validate(payload)
                pending[pause.tool_call_id] = pause
        elif event.event_type == "tool_execution_recorded" and event.tool_call_id is not None:
            pending.pop(event.tool_call_id, None)
    return pending


def _validate_tool_policy(
    side_effects: SideEffects,
    policy: ToolExecutionPolicy,
) -> NativeRunError | None:
    if policy.mode == "disabled":
        return NativeRunError(
            error_kind="tool_denied",
            error_code="tool_execution_disabled",
            retryable=False,
            owner="fusionkit",
            terminal_reason="tool_policy_disabled",
        )
    if policy.mode == "executor" and not policy.executor_configured:
        return NativeRunError(
            error_kind="tool_denied",
            error_code="executor_not_configured",
            retryable=False,
            owner="fusionkit",
            terminal_reason="executor_mode_not_configured",
        )
    if policy.mode == "executor":
        return NativeRunError(
            error_kind="tool_denied",
            error_code="executor_not_implemented",
            retryable=False,
            owner="fusionkit",
            terminal_reason="executor_mode_not_implemented",
        )
    if side_effects not in policy.allowed_side_effects:
        return NativeRunError(
            error_kind="tool_denied",
            error_code="tool_side_effect_not_allowed",
            retryable=False,
            owner="fusionkit",
            terminal_reason="tool_side_effect_not_allowed_by_policy",
        )
    if side_effects != "read_only" and not (policy.policy_id and policy.environment):
        return NativeRunError(
            error_kind="tool_denied",
            error_code="tool_side_effect_requires_policy_environment",
            retryable=False,
            owner="fusionkit",
            terminal_reason="tool_side_effect_requires_policy_environment",
        )
    return None


def _policy_cache_key(
    *,
    tool_name: str,
    arguments_hash: str,
    side_effects: SideEffects,
    policy: ToolExecutionPolicy,
) -> str | None:
    if side_effects != "read_only" or not policy.dedupe_read_only:
        return None
    return hash_json(
        {
            "tool_name": tool_name,
            "arguments_hash": arguments_hash,
            "side_effects": side_effects,
            "policy_id": policy.policy_id,
            "environment": policy.environment,
        }
    )


def _candidate_id_for_source(
    candidate_infos: Sequence[CandidateInspection],
    source_candidate_id: str,
) -> str | None:
    for candidate_info in candidate_infos:
        if candidate_info.source_candidate_id == source_candidate_id:
            return candidate_info.candidate_id
    return candidate_infos[0].candidate_id if candidate_infos else None


def _run_metrics(
    candidates: Sequence[Candidate],
    selected_mode: FusionMode,
    analysis: FusionAnalysis | None,
) -> dict[str, Any]:
    metrics: dict[str, Any] = {
        "candidate_count": len(candidates),
        "candidate_model_ids": [candidate.model_id for candidate in candidates],
        "mode": selected_mode,
    }
    if analysis is not None:
        metrics["analysis"] = analysis.model_dump(mode="json")
    return metrics


__all__ = [
    "CandidateInspection",
    "CreateRunResult",
    "FusionRunEvent",
    "FusionRunManager",
    "IdempotencyOutcome",
    "IdempotencyRecord",
    "NativeRunError",
    "RunEventPage",
    "RunEventType",
    "RunInspection",
    "RunStateSummary",
    "ToolPausePlaceholder",
    "ToolExecutionMode",
    "ToolExecutionPolicy",
    "ToolResultSubmission",
    "canonical_json",
    "hash_json",
    "make_id",
]
