from __future__ import annotations

from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import pytest
from fusionkit_core.artifacts import LocalArtifactStore
from fusionkit_core.clients import FakeModelClient
from fusionkit_core.config import FusionConfig, ModelEndpoint, SamplingConfig
from fusionkit_core.contracts import (
    FusionRunRequestV1,
    ModelCallRecordV1,
    contract_metadata,
)
from fusionkit_core.fusion import FusionEngine
from fusionkit_core.run import CreateRunResult, FusionRunManager, RunInspection
from fusionkit_core.run_store import FileSystemRunStore
from fusionkit_core.types import ChatMessage, ModelResponse


class _FailingChatClient:
    def __init__(self, model_id: str) -> None:
        self.model_id = model_id

    async def chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[Any] | None = None,
        tool_choice: Any | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> ModelResponse:
        raise RuntimeError("provider exploded")

    def stream_chat(self, *args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("provider exploded")

    async def aclose(self) -> None:
        return None


@pytest.mark.asyncio
async def test_tracked_fusion_run_completes_and_is_inspectable(tmp_path) -> None:
    manager, store = _manager(tmp_path)
    request = _request(mode="panel", request_id="fusion_req_complete_001")

    result = await manager.create_and_run(request, idempotency_key="complete-key")

    assert isinstance(result, RunInspection)
    assert result.state == "completed"
    assert result.final_output == "fused final answer"
    assert len(result.trajectories) == 1
    assert result.model_call_ids
    assert result.judge_synthesis_record is not None
    assert result.judge_synthesis_record["schema"] == "judge-synthesis-record.v1"
    assert result.final_output_artifact is not None
    assert Path(result.final_output_artifact.uri or "").exists()

    summary = store.read_summary(result.run_id)
    assert summary.state == "completed"
    assert store.inspect_run(result.run_id).trajectories[0].artifact is not None

    model_call_events = [
        event
        for event in store.list_events(result.run_id)
        if event.event_type == "model_call_recorded"
    ]
    assert model_call_events
    ModelCallRecordV1.model_validate(model_call_events[0].payload["model_call_record"])


@pytest.mark.asyncio
async def test_tracked_fusion_run_records_failure(tmp_path) -> None:
    config = FusionConfig(
        endpoints=[ModelEndpoint(id="fast", model="fake-fast", base_url="http://localhost:8101")],
        default_model="fast",
        default_mode="single",
    )
    engine = FusionEngine(config=config, clients={})
    store = FileSystemRunStore(tmp_path / "runs")
    manager = FusionRunManager(engine, store, LocalArtifactStore(tmp_path / "runs"))

    result = await manager.create_and_run(_request(mode="single", request_id="fusion_req_fail_001"))

    assert isinstance(result, RunInspection)
    assert result.state == "failed"
    assert result.terminal_error is not None
    assert result.terminal_error.terminal_reason == "run_execution_failed"


@pytest.mark.asyncio
async def test_tracked_panel_run_completes_with_failed_model_call(tmp_path) -> None:
    config = FusionConfig(
        endpoints=[
            ModelEndpoint(id="fast", model="fake-fast", base_url="http://localhost:8101"),
            ModelEndpoint(id="broken", model="fake-broken", base_url="http://localhost:8103"),
            ModelEndpoint(id="judge", model="fake-judge", base_url="http://localhost:8102"),
        ],
        default_model="fast",
        judge_model="judge",
        default_mode="panel",
        panel_models=["fast", "broken"],
    )
    clients = {
        "fast": FakeModelClient("fast", ["fast candidate with evidence"]),
        "broken": _FailingChatClient("broken"),
        "judge": FakeModelClient(
            "judge",
            [
                '{"consensus":["candidate has evidence"],"contradictions":[],'
                '"unique_insights":[],"coverage_gaps":[],"likely_errors":[],'
                '"recommended_final_structure":["short"]}',
                "fused final answer",
            ],
        ),
    }
    engine = FusionEngine(config=config, clients=clients)
    store = FileSystemRunStore(tmp_path / "runs")
    manager = FusionRunManager(engine, store, LocalArtifactStore(tmp_path / "runs"))
    request = FusionRunRequestV1.model_validate(
        {
            **contract_metadata("fusion-run-request.v1"),
            "request_id": "fusion_req_partial_001",
            "mode": "panel",
            "messages": [
                ChatMessage(role="user", content="Explain model fusion").model_dump(
                    mode="json", include={"role", "content"}
                )
            ],
            "sampling": {},
            "requested_models": ["fast", "broken"],
        }
    )

    result = await manager.create_and_run(request, idempotency_key="partial-key")

    assert isinstance(result, RunInspection)
    assert result.state == "completed"
    assert result.final_output == "fused final answer"

    records = [
        ModelCallRecordV1.model_validate(event.payload["model_call_record"])
        for event in store.list_events(result.run_id)
        if event.event_type == "model_call_recorded"
    ]
    statuses = {record.model: record.status for record in records}
    assert statuses == {"fast": "succeeded", "broken": "failed"}
    broken_record = next(record for record in records if record.model == "broken")
    assert broken_record.error is not None
    assert broken_record.error.kind == "provider_error"


@pytest.mark.asyncio
async def test_tracked_panel_run_fails_when_all_models_fail(tmp_path) -> None:
    config = FusionConfig(
        endpoints=[
            ModelEndpoint(id="broken", model="fake-broken", base_url="http://localhost:8103"),
            ModelEndpoint(id="judge", model="fake-judge", base_url="http://localhost:8102"),
        ],
        default_model="broken",
        judge_model="judge",
        default_mode="panel",
        panel_models=["broken"],
    )
    clients = {
        "broken": _FailingChatClient("broken"),
        "judge": FakeModelClient("judge", ["unused"]),
    }
    engine = FusionEngine(config=config, clients=clients)
    store = FileSystemRunStore(tmp_path / "runs")
    manager = FusionRunManager(engine, store, LocalArtifactStore(tmp_path / "runs"))
    request = FusionRunRequestV1.model_validate(
        {
            **contract_metadata("fusion-run-request.v1"),
            "request_id": "fusion_req_allfail_001",
            "mode": "panel",
            "messages": [
                ChatMessage(role="user", content="Explain model fusion").model_dump(
                    mode="json", include={"role", "content"}
                )
            ],
            "sampling": {},
            "requested_models": ["broken"],
        }
    )

    result = await manager.create_and_run(request)

    assert isinstance(result, RunInspection)
    assert result.state == "failed"
    assert result.terminal_error is not None
    assert result.terminal_error.terminal_reason == "all_models_failed"


@pytest.mark.asyncio
async def test_tracked_fusion_run_can_be_cancelled_before_execution(tmp_path) -> None:
    manager, store = _manager(tmp_path)
    created = manager.create_run(_request(mode="panel", request_id="fusion_req_cancel_001"))
    assert created.run_id is not None

    cancelled = manager.cancel_run(created.run_id)
    result = await manager.execute_run(created.run_id)

    assert cancelled.state == "cancelled"
    assert result.state == "cancelled"
    assert not [
        event
        for event in store.list_events(created.run_id)
        if event.event_type == "model_call_recorded"
    ]


@pytest.mark.asyncio
async def test_tracked_fusion_run_idempotency_replays_same_request(tmp_path) -> None:
    manager, _store = _manager(tmp_path)
    request = _request(mode="panel", request_id="fusion_req_replay_001")

    first = await manager.create_and_run(request, idempotency_key="replay-key")
    second = await manager.create_and_run(request, idempotency_key="replay-key")

    assert isinstance(first, RunInspection)
    assert isinstance(second, CreateRunResult)
    assert second.idempotency_outcome == "replayed"
    assert second.run_id == first.run_id


def test_tracked_fusion_run_idempotency_conflict_is_explicit(tmp_path) -> None:
    manager, _store = _manager(tmp_path)
    first = manager.create_run(
        _request(mode="single", request_id="fusion_req_same_001"),
        idempotency_key="conflict-key",
    )
    second = manager.create_run(
        _request(mode="panel", request_id="fusion_req_other_001"),
        idempotency_key="conflict-key",
    )

    assert first.idempotency_outcome == "created"
    assert second.idempotency_outcome == "conflict"
    assert second.terminal_error is not None
    assert second.terminal_error.error_code == "idempotency_conflict"


def test_tracked_fusion_run_requires_action_placeholder_is_inspectable(tmp_path) -> None:
    manager, store = _manager(tmp_path)
    created = manager.create_run(_request(mode="panel", request_id="fusion_req_tool_001"))
    assert created.run_id is not None

    pause = manager.record_requires_action(
        created.run_id,
        trajectory_id="trajectory_tool_001",
        tool_call_id="tool_call_read_001",
        plan={"schema": "tool-call-plan.v1", "plan_id": "tool_plan_read_001"},
    )

    summary = store.read_summary(created.run_id)
    inspection = store.inspect_run(created.run_id)
    assert pause.tool_call_id == "tool_call_read_001"
    assert summary.state == "requires_action"
    assert inspection.requires_action is not None
    assert inspection.requires_action.tool_call_id == "tool_call_read_001"
    assert inspection.judge_synthesis_record is None


def _manager(tmp_path) -> tuple[FusionRunManager, FileSystemRunStore]:
    config = FusionConfig(
        endpoints=[
            ModelEndpoint(id="fast", model="fake-fast", base_url="http://localhost:8101"),
            ModelEndpoint(id="judge", model="fake-judge", base_url="http://localhost:8102"),
        ],
        default_model="fast",
        judge_model="judge",
        default_mode="panel",
        panel_models=["fast"],
    )
    clients = {
        "fast": FakeModelClient("fast", ["fast candidate with evidence"]),
        "judge": FakeModelClient(
            "judge",
            [
                '{"consensus":["candidate has evidence"],"contradictions":[],'
                '"unique_insights":[],"coverage_gaps":[],"likely_errors":[],'
                '"recommended_final_structure":["short"]}',
                "fused final answer",
            ],
        ),
    }
    engine = FusionEngine(config=config, clients=clients)
    store = FileSystemRunStore(tmp_path / "runs")
    return FusionRunManager(engine, store, LocalArtifactStore(tmp_path / "runs")), store


def _request(mode: str, request_id: str) -> FusionRunRequestV1:
    return FusionRunRequestV1.model_validate(
        {
            **contract_metadata("fusion-run-request.v1"),
            "request_id": request_id,
            "mode": mode,
            "messages": [
                ChatMessage(role="user", content="Explain model fusion").model_dump(
                    mode="json", include={"role", "content"}
                )
            ],
            "sampling": {},
            "requested_models": ["fast"] if mode == "panel" else None,
        }
    )
