from __future__ import annotations

import json
import time
import uuid
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel

from fusionkit_core.artifacts import hash_text
from fusionkit_core.config import FusionConfig, ModelEndpoint, SamplingConfig
from fusionkit_core.contracts import (
    ContractArtifactRef,
    ContractError,
    FusionMode,
    FusionRecordV1,
    FusionRunRequestV1,
    FusionRunState,
    ModelCallRecordV1,
    SideEffects,
    ToolCallPlanV1,
    ToolExecutionRecordV1,
    contract_metadata,
    status_for_run_state,
)
from fusionkit_core.fusion import FusionEngine
from fusionkit_core.producers import PanelExhaustedError
from fusionkit_core.providers import provider_metadata
from fusionkit_core.run_models import (
    ArtifactWriter,
    CreateRunResult,
    FusionRunEvent,
    IdempotencyOutcome,
    IdempotencyRecord,
    NativeRunError,
    RunEventPage,
    RunEventType,
    RunInspection,
    RunStateSummary,
    RunStore,
    ToolExecutionMode,
    ToolExecutionPolicy,
    ToolPausePlaceholder,
    ToolResultSubmission,
    TrajectoryInspection,
)
from fusionkit_core.types import ChatMessage, FusionAnalysis, Trajectory

__all__ = [
    "ArtifactWriter",
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
    "RunStore",
    "ToolExecutionMode",
    "ToolExecutionPolicy",
    "ToolPausePlaceholder",
    "ToolResultSubmission",
    "TrajectoryInspection",
    "canonical_json",
    "hash_json",
    "make_id",
]

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
        started = time.perf_counter()
        self._append_state(summary, "generating")
        try:
            selected_mode: FusionMode = request.mode
            if selected_mode == "router":
                decision = self.engine.router.route(_runtime_messages(request.messages))
                selected_mode = decision.route

            sampling = _sampling_from_request(request)
            budget_error = self._check_candidate_budget(request, selected_mode)
            if budget_error is not None:
                return self._fail_run(summary, budget_error)
            budget_error = self._check_wall_clock_budget(started)
            if budget_error is not None:
                return self._fail_run(summary, budget_error)
            trajectories = await self._generate_trajectories(request, selected_mode, sampling)
            trajectory_infos, model_call_ids, trajectory_artifacts = self._record_trajectories(
                run_id,
                summary.trace_id,
                request,
                trajectories,
            )
            budget_error = self._check_cost_budget(run_id)
            if budget_error is not None:
                return self._fail_run(summary, budget_error)

            analysis: FusionAnalysis | None = None
            answer: str
            fused_synthesis = None
            selected_trajectory_id = (
                trajectory_infos[0].trajectory_id if trajectory_infos else None
            )
            if selected_mode == "single":
                answer = trajectories[0].content if trajectories else ""
            else:
                first_succeeded = next(
                    (t for t in trajectories if t.status == "succeeded"),
                    trajectories[0] if trajectories else None,
                )
                if first_succeeded is not None:
                    selected_trajectory_id = _trajectory_id_for_source(
                        trajectory_infos, first_succeeded.id
                    )
                self._append_state(summary, "judging")
                self._append_state(summary, "synthesizing")
                fused = await self.engine._judge_synthesize(
                    _runtime_messages(request.messages),
                    trajectories,
                )
                answer = fused.response.content
                analysis = fused.analysis
                fused_synthesis = (
                    fused.trajectory.synthesis if fused.trajectory is not None else None
                )

            final_artifact = self.artifacts.write_text(
                run_id,
                make_id("artifact_final"),
                "transcript",
                answer,
            )
            self._append_artifact_event(run_id, summary.trace_id, "synthesizing", final_artifact)
            artifacts = [*trajectory_artifacts, final_artifact]
            synthesis_record: dict[str, Any] | None = None
            if fused_synthesis is not None and fused_synthesis.input_trajectory_ids:
                # The fusion result lives on the fused trajectory's `synthesis`
                # metadata (there is no standalone judge-synthesis-record.v1
                # contract anymore); the runs API surfaces it as a plain
                # `judge_synthesis_recorded` event for the inspect view and the
                # benchmark harness.
                synthesis_record = {
                    "synthesis_id": make_id("synthesis"),
                    "input_trajectory_ids": fused_synthesis.input_trajectory_ids,
                    "status": "succeeded",
                    "decision": fused_synthesis.decision,
                    "selected_trajectory_id": fused_synthesis.selected_trajectory_id,
                    "rationale": fused_synthesis.rationale,
                    "final_output": answer,
                    "metrics": {
                        **(fused_synthesis.metrics or {}),
                        "final_output_artifact_id": final_artifact.artifact_id,
                    },
                }
                self.store.append_event(
                    FusionRunEvent(
                        event_seq=1,
                        run_id=run_id,
                        trace_id=summary.trace_id,
                        state="synthesizing",
                        status=status_for_run_state("synthesizing"),
                        event_type="judge_synthesis_recorded",
                        payload={"judge_synthesis_record": synthesis_record},
                    )
                )

            fusion_record = FusionRecordV1.model_validate(
                {
                    **contract_metadata("fusion-record.v1"),
                    "run_id": run_id,
                    "request_id": request.request_id,
                    "mode": selected_mode,
                    "status": "succeeded",
                    "trajectory_ids": [
                        trajectory.trajectory_id for trajectory in trajectory_infos
                    ],
                    "model_call_ids": model_call_ids,
                    "selected_trajectory_id": selected_trajectory_id,
                    "synthesis_record_id": (
                        synthesis_record["synthesis_id"] if synthesis_record is not None else None
                    ),
                    "final_output": answer,
                    "started_at": summary.event_cursor and events[0].created_at,
                    "finished_at": datetime.now(UTC),
                    "metrics": {
                        **_run_metrics(trajectories, selected_mode, analysis),
                        "cost_estimate": _run_cost_estimate(self.store.list_events(run_id)),
                    },
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
        except PanelExhaustedError as exc:
            error = NativeRunError(
                error_kind="provider_error",
                error_code=exc.__class__.__name__,
                retryable=True,
                owner="fusionkit",
                terminal_reason="all_models_failed",
                message=str(exc),
            )
            return self._fail_run(summary, error)
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
        trajectory_id: str,
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
            trajectory_id=trajectory_id,
            tool_call_id=tool_call_id,
            plan=tool_plan,
            policy_cache_key=None,
        )

    def request_tool_action(
        self,
        run_id: str,
        *,
        trajectory_id: str,
        tool_name: str,
        arguments: Mapping[str, Any] | None = None,
        side_effects: SideEffects = "read_only",
        policy: ToolExecutionPolicy | None = None,
    ) -> ToolPausePlaceholder | NativeRunError:
        resolved_policy = policy or ToolExecutionPolicy()
        budget_error = self._check_tool_budget(run_id)
        if budget_error is not None:
            return budget_error
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
                trajectory_id=trajectory_id,
                tool_call_id=tool_call_id,
                payload={
                    "tool_call_plan": plan.model_dump(mode="json"),
                    "policy_cache_key": policy_cache_key,
                },
            )
        )
        return self._pause_for_tool_action(
            run_id,
            trajectory_id=trajectory_id,
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
        if pending.trajectory_id != submission.trajectory_id:
            return NativeRunError(
                error_kind="validation_error",
                error_code="tool_trajectory_mismatch",
                retryable=False,
                owner="fusionkit",
                terminal_reason="tool_result_for_wrong_trajectory",
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
                trajectory_id=submission.trajectory_id,
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
                trajectory_id=submission.trajectory_id,
                tool_call_id=submission.tool_call_id,
                payload={
                    "resumed_trajectory_id": submission.trajectory_id,
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
        trajectory_id: str,
        tool_call_id: str | None,
        plan: ToolCallPlanV1 | None,
        policy_cache_key: str | None,
    ) -> ToolPausePlaceholder:
        summary = self.store.read_summary(run_id)
        pause = ToolPausePlaceholder(
            trajectory_id=trajectory_id,
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
                trajectory_id=trajectory_id,
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

    async def _generate_trajectories(
        self,
        request: FusionRunRequestV1,
        selected_mode: FusionMode,
        sampling: SamplingConfig,
    ) -> list[Trajectory]:
        messages = _runtime_messages(request.messages)
        if selected_mode == "single":
            return [
                await self.engine.producer.generate_single(
                    self.engine.config.default_model,
                    messages,
                    sampling,
                )
            ]
        return await self.engine._generate_trajectories(
            mode=selected_mode,
            messages=messages,
            sampling=sampling,
            panel_models=request.requested_models,
            sample_count=request.sample_count,
        )

    def _record_trajectories(
        self,
        run_id: str,
        trace_id: str,
        request: FusionRunRequestV1,
        trajectories: Sequence[Trajectory],
    ) -> tuple[list[TrajectoryInspection], list[str], list[ContractArtifactRef]]:
        trajectory_infos = []
        model_call_ids = []
        artifacts = []
        for index, trajectory in enumerate(trajectories):
            trajectory_id = make_id("trajectory")
            model_call_id = make_id("model_call")
            artifact = self.artifacts.write_text(
                run_id,
                make_id("artifact_trajectory"),
                "transcript",
                trajectory.content,
            )
            artifacts.append(artifact)
            model_call = _model_call_record(
                self.engine.config,
                request=request,
                trajectory=trajectory,
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
                    trajectory_id=trajectory_id,
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
                    event_type="trajectory_recorded",
                    trajectory_id=trajectory_id,
                    model_call_id=model_call_id,
                    artifact_id=artifact.artifact_id,
                    payload={
                        "trajectory": {
                            "trajectory_id": trajectory_id,
                            "source_trajectory_id": trajectory.id,
                            "model_id": trajectory.model_id,
                            "artifact": artifact.model_dump(mode="json"),
                            "ordinal": index,
                        }
                    },
                )
            )
            trajectory_infos.append(
                TrajectoryInspection(
                    trajectory_id=trajectory_id,
                    model_id=trajectory.model_id,
                    source_trajectory_id=trajectory.id,
                    model_call_id=model_call_id,
                    artifact=artifact,
                )
            )
            model_call_ids.append(model_call_id)
        return trajectory_infos, model_call_ids, artifacts

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

    def _fail_run(self, summary: RunStateSummary, error: NativeRunError) -> RunInspection:
        event = self.store.append_event(
            FusionRunEvent(
                event_seq=1,
                run_id=summary.run_id,
                trace_id=summary.trace_id,
                state="failed",
                status=status_for_run_state("failed"),
                event_type="error_recorded",
                payload={"error": error.model_dump(mode="json")},
            )
        )
        self.store.write_summary(
            summary.model_copy(
                update={
                    "state": "failed",
                    "status": status_for_run_state("failed"),
                    "event_cursor": event.event_seq,
                    "terminal_error": error,
                    "terminal_reason": error.terminal_reason,
                }
            )
        )
        return self.store.inspect_run(summary.run_id)

    def _check_candidate_budget(
        self,
        request: FusionRunRequestV1,
        selected_mode: FusionMode,
    ) -> NativeRunError | None:
        budget = self.engine.config.budget
        if budget.max_candidates is None:
            return None
        if selected_mode == "single":
            candidate_count = 1
        elif selected_mode == "panel":
            candidate_count = len(request.requested_models or self.engine.config.panel_models)
            if candidate_count == 0:
                candidate_count = len(self.engine.config.endpoints)
        else:
            candidate_count = request.sample_count or self.engine.config.sample_count
        if candidate_count <= budget.max_candidates:
            return None
        return _budget_error("max_candidates", f"candidate_count {candidate_count} exceeded budget")

    def _check_wall_clock_budget(self, started: float) -> NativeRunError | None:
        budget = self.engine.config.budget
        if budget.wall_clock_s is None:
            return None
        if time.perf_counter() - started <= budget.wall_clock_s:
            return None
        return _budget_error("wall_clock_s", "wall-clock budget exceeded")

    def _check_cost_budget(self, run_id: str) -> NativeRunError | None:
        budget = self.engine.config.budget
        if budget.max_cost is None:
            return None
        cost = _run_cost_estimate(self.store.list_events(run_id))
        if cost is None or cost <= budget.max_cost:
            return None
        return _budget_error("max_cost", f"estimated cost {cost:.8f} exceeded budget")

    def _check_tool_budget(self, run_id: str) -> NativeRunError | None:
        budget = self.engine.config.budget
        events = self.store.list_events(run_id)
        planned = [event for event in events if event.event_type == "tool_call_planned"]
        pauses = [event for event in events if event.event_type == "requires_action"]
        if budget.max_tool_calls is not None and len(planned) + 1 > budget.max_tool_calls:
            return _budget_error("max_tool_calls", "tool call budget exceeded")
        if budget.max_tool_rounds is not None and len(pauses) + 1 > budget.max_tool_rounds:
            return _budget_error("max_tool_rounds", "tool round budget exceeded")
        return None


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
    config,
    *,
    request: FusionRunRequestV1,
    trajectory: Trajectory,
    model_call_id: str,
) -> ModelCallRecordV1:
    latency_s = trajectory.metadata.get("latency_s")
    usage = trajectory.metadata.get("usage")
    latency_ms = latency_s * 1000 if isinstance(latency_s, int | float) else None
    endpoint = _endpoint_for_trajectory(config, trajectory.model_id)
    metadata = {
        **provider_metadata(endpoint, usage if isinstance(usage, dict) else None),
        "finish_reason": trajectory.metadata.get("finish_reason"),
    }
    failed = trajectory.status == "failed"
    error = None
    if failed:
        error = ContractError(
            kind="provider_error",
            message=trajectory.metadata.get("error_message"),
            retryable=True,
        )
    return ModelCallRecordV1.model_validate(
        {
            **contract_metadata("model-call-record.v1"),
            "call_id": model_call_id,
            "endpoint_id": trajectory.model_id,
            "model": trajectory.model_id,
            "request_hash": hash_json(
                {
                    "request_id": request.request_id,
                    "model_id": trajectory.model_id,
                    "messages": [message.model_dump(mode="json") for message in request.messages],
                }
            ),
            "response_hash": hash_text(trajectory.content),
            "status": "failed" if failed else "succeeded",
            "messages": [message.model_dump(mode="json") for message in request.messages],
            "side_effects": "none",
            "started_at": datetime.now(UTC),
            "finished_at": datetime.now(UTC),
            "latency_ms": latency_ms,
            "usage": usage if isinstance(usage, dict) else None,
            "output_text": trajectory.content,
            "error": error.model_dump(mode="json") if error is not None else None,
            "metadata": metadata,
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


def _endpoint_for_trajectory(config: FusionConfig, model_id: str) -> ModelEndpoint | None:
    try:
        return config.endpoint_for(model_id)
    except KeyError:
        return None


def _run_cost_estimate(events: Sequence[FusionRunEvent]) -> float | None:
    costs = []
    for event in events:
        if event.event_type != "model_call_recorded":
            continue
        record = event.payload.get("model_call_record")
        if not isinstance(record, dict):
            continue
        metadata = record.get("metadata")
        if not isinstance(metadata, dict):
            continue
        cost = metadata.get("cost_estimate")
        if isinstance(cost, int | float):
            costs.append(float(cost))
    if not costs:
        return None
    return sum(costs)


def _budget_error(field: str, message: str) -> NativeRunError:
    return NativeRunError(
        error_kind="validation_error",
        error_code="budget_exceeded",
        retryable=False,
        owner="fusionkit",
        terminal_reason=f"budget_exceeded:{field}",
        message=message,
    )


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


def _trajectory_id_for_source(
    trajectory_infos: Sequence[TrajectoryInspection],
    source_trajectory_id: str,
) -> str | None:
    for trajectory_info in trajectory_infos:
        if trajectory_info.source_trajectory_id == source_trajectory_id:
            return trajectory_info.trajectory_id
    return trajectory_infos[0].trajectory_id if trajectory_infos else None


def _run_metrics(
    trajectories: Sequence[Trajectory],
    selected_mode: FusionMode,
    analysis: FusionAnalysis | None,
) -> dict[str, Any]:
    succeeded_count = sum(1 for trajectory in trajectories if trajectory.status == "succeeded")
    metrics: dict[str, Any] = {
        "trajectory_count": len(trajectories),
        "succeeded_trajectory_count": succeeded_count,
        "failed_trajectory_count": len(trajectories) - succeeded_count,
        "trajectory_model_ids": [trajectory.model_id for trajectory in trajectories],
        "mode": selected_mode,
    }
    if analysis is not None:
        metrics["analysis"] = analysis.model_dump(mode="json")
    return metrics


__all__ = [
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
    "TrajectoryInspection",
    "canonical_json",
    "hash_json",
    "make_id",
]
