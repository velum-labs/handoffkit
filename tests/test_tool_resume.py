from __future__ import annotations

from fastapi.testclient import TestClient
from fusionkit_core.artifacts import LocalArtifactStore
from fusionkit_core.clients import FakeModelClient
from fusionkit_core.config import FusionConfig, ModelEndpoint
from fusionkit_core.contracts import (
    FusionRunRequestV1,
    ToolCallPlanV1,
    ToolExecutionRecordV1,
    contract_metadata,
)
from fusionkit_core.fusion import FusionEngine
from fusionkit_core.run import (
    FusionRunManager,
    NativeRunError,
    ToolExecutionPolicy,
    ToolResultSubmission,
)
from fusionkit_core.run_store import FileSystemRunStore
from fusionkit_server import create_app


def test_two_candidates_can_pause_for_different_read_only_tools(tmp_path) -> None:
    manager, store = _manager(tmp_path)
    created = manager.create_run(_request("fusion_req_tools_001"))
    assert created.run_id is not None
    policy = ToolExecutionPolicy(mode="external")

    first = manager.request_tool_action(
        created.run_id,
        trajectory_id="candidate_a",
        tool_name="read_file",
        arguments={"path": "README.md"},
        policy=policy,
    )
    second = manager.request_tool_action(
        created.run_id,
        trajectory_id="candidate_b",
        tool_name="list_files",
        arguments={"path": "packages"},
        policy=policy,
    )

    assert not isinstance(first, NativeRunError)
    assert not isinstance(second, NativeRunError)
    assert first.trajectory_id == "candidate_a"
    assert second.trajectory_id == "candidate_b"
    assert first.plan is not None
    ToolCallPlanV1.model_validate(first.plan.model_dump(mode="json"))
    planned = [
        event
        for event in store.list_events(created.run_id)
        if event.event_type == "tool_call_planned"
    ]
    assert len(planned) == 2


def test_read_only_tool_calls_expose_dedupe_key(tmp_path) -> None:
    manager, _store = _manager(tmp_path)
    created = manager.create_run(_request("fusion_req_tool_dedupe_001"))
    assert created.run_id is not None
    policy = ToolExecutionPolicy(mode="external", policy_id="readonly")

    first = manager.request_tool_action(
        created.run_id,
        trajectory_id="candidate_a",
        tool_name="read_file",
        arguments={"path": "README.md"},
        policy=policy,
    )
    second = manager.request_tool_action(
        created.run_id,
        trajectory_id="candidate_b",
        tool_name="read_file",
        arguments={"path": "README.md"},
        policy=policy,
    )

    assert not isinstance(first, NativeRunError)
    assert not isinstance(second, NativeRunError)
    assert first.policy_cache_key is not None
    assert first.policy_cache_key == second.policy_cache_key


def test_unsafe_side_effects_require_policy_and_environment(tmp_path) -> None:
    manager, _store = _manager(tmp_path)
    created = manager.create_run(_request("fusion_req_tool_unsafe_001"))
    assert created.run_id is not None

    denied = manager.request_tool_action(
        created.run_id,
        trajectory_id="candidate_a",
        tool_name="write_file",
        arguments={"path": "README.md"},
        side_effects="writes_workspace",
        policy=ToolExecutionPolicy(mode="external"),
    )

    assert isinstance(denied, NativeRunError)
    assert denied.error_code == "tool_side_effect_not_allowed"


def test_executor_mode_is_explicitly_not_implemented(tmp_path) -> None:
    manager, _store = _manager(tmp_path)
    created = manager.create_run(_request("fusion_req_tool_executor_001"))
    assert created.run_id is not None

    denied = manager.request_tool_action(
        created.run_id,
        trajectory_id="candidate_a",
        tool_name="read_file",
        arguments={"path": "README.md"},
        policy=ToolExecutionPolicy(mode="executor"),
    )

    assert isinstance(denied, NativeRunError)
    assert denied.error_code == "executor_not_configured"


def test_tool_result_resume_records_execution_for_matching_candidate(tmp_path) -> None:
    manager, store = _manager(tmp_path)
    created = manager.create_run(_request("fusion_req_tool_resume_001"))
    assert created.run_id is not None
    pause = manager.request_tool_action(
        created.run_id,
        trajectory_id="candidate_a",
        tool_name="read_file",
        arguments={"path": "README.md"},
        policy=ToolExecutionPolicy(mode="external"),
    )
    assert not isinstance(pause, NativeRunError)

    result = manager.submit_tool_result(
        created.run_id,
        ToolResultSubmission(
            trajectory_id="candidate_a",
            tool_call_id=pause.tool_call_id,
            tool_name="read_file",
            output="synthetic contents",
        ),
    )

    assert not isinstance(result, NativeRunError)
    assert result.state == "generating"
    assert result.requires_action is None
    execution_events = [
        event
        for event in store.list_events(created.run_id)
        if event.event_type == "tool_execution_recorded"
    ]
    assert execution_events
    ToolExecutionRecordV1.model_validate(
        execution_events[0].payload["tool_execution_record"]
    )
    assert any(event.event_type == "run_resumed" for event in store.list_events(created.run_id))


def test_tool_result_can_resume_first_of_two_pending_candidate_tools(tmp_path) -> None:
    manager, store = _manager(tmp_path)
    created = manager.create_run(_request("fusion_req_tool_two_pending_001"))
    assert created.run_id is not None
    first = manager.request_tool_action(
        created.run_id,
        trajectory_id="candidate_a",
        tool_name="read_file",
        arguments={"path": "README.md"},
        policy=ToolExecutionPolicy(mode="external"),
    )
    second = manager.request_tool_action(
        created.run_id,
        trajectory_id="candidate_b",
        tool_name="list_files",
        arguments={"path": "packages"},
        policy=ToolExecutionPolicy(mode="external"),
    )
    assert not isinstance(first, NativeRunError)
    assert not isinstance(second, NativeRunError)

    result = manager.submit_tool_result(
        created.run_id,
        ToolResultSubmission(
            trajectory_id="candidate_a",
            tool_call_id=first.tool_call_id,
            tool_name="read_file",
            output="synthetic contents",
        ),
    )

    assert not isinstance(result, NativeRunError)
    assert result.state == "requires_action"
    assert result.requires_action is not None
    assert result.requires_action.tool_call_id == second.tool_call_id
    assert store.read_summary(created.run_id).state == "requires_action"


def test_tool_result_wrong_candidate_is_rejected(tmp_path) -> None:
    manager, _store = _manager(tmp_path)
    created = manager.create_run(_request("fusion_req_tool_wrong_candidate_001"))
    assert created.run_id is not None
    pause = manager.request_tool_action(
        created.run_id,
        trajectory_id="candidate_a",
        tool_name="read_file",
        arguments={"path": "README.md"},
        policy=ToolExecutionPolicy(mode="external"),
    )
    assert not isinstance(pause, NativeRunError)

    result = manager.submit_tool_result(
        created.run_id,
        ToolResultSubmission(
            trajectory_id="candidate_b",
            tool_call_id=pause.tool_call_id,
            tool_name="read_file",
            output="synthetic contents",
        ),
    )

    assert isinstance(result, NativeRunError)
    assert result.error_code == "tool_trajectory_mismatch"


def test_tool_result_wrong_tool_name_is_rejected(tmp_path) -> None:
    manager, _store = _manager(tmp_path)
    created = manager.create_run(_request("fusion_req_tool_wrong_name_001"))
    assert created.run_id is not None
    pause = manager.request_tool_action(
        created.run_id,
        trajectory_id="candidate_a",
        tool_name="read_file",
        arguments={"path": "README.md"},
        policy=ToolExecutionPolicy(mode="external"),
    )
    assert not isinstance(pause, NativeRunError)

    result = manager.submit_tool_result(
        created.run_id,
        ToolResultSubmission(
            trajectory_id="candidate_a",
            tool_call_id=pause.tool_call_id,
            tool_name="list_files",
            output="synthetic contents",
        ),
    )

    assert isinstance(result, NativeRunError)
    assert result.error_code == "tool_name_mismatch"


def test_tool_results_api_resumes_candidate_scoped_tool_call(tmp_path) -> None:
    manager, _store = _manager(tmp_path)
    created = manager.create_run(_request("fusion_req_tool_api_001"))
    assert created.run_id is not None
    pause = manager.request_tool_action(
        created.run_id,
        trajectory_id="candidate_a",
        tool_name="read_file",
        arguments={"path": "README.md"},
        policy=ToolExecutionPolicy(mode="external"),
    )
    assert not isinstance(pause, NativeRunError)
    client = _client(manager)

    response = client.post(
        f"/v1/fusion/runs/{created.run_id}/tool-results",
        json={
            "trajectory_id": "candidate_a",
            "tool_call_id": pause.tool_call_id,
            "tool_name": "read_file",
            "output": "synthetic contents",
        },
    )

    assert response.status_code == 200
    assert response.json()["state"] == "generating"
    assert response.json()["requires_action"] is None


def test_tool_results_api_rejects_wrong_tool_call(tmp_path) -> None:
    manager, _store = _manager(tmp_path)
    created = manager.create_run(_request("fusion_req_tool_api_wrong_001"))
    assert created.run_id is not None
    pause = manager.request_tool_action(
        created.run_id,
        trajectory_id="candidate_a",
        tool_name="read_file",
        arguments={"path": "README.md"},
        policy=ToolExecutionPolicy(mode="external"),
    )
    assert not isinstance(pause, NativeRunError)
    client = _client(manager)

    response = client.post(
        f"/v1/fusion/runs/{created.run_id}/tool-results",
        json={
            "trajectory_id": "candidate_a",
            "tool_call_id": "tool_call_wrong",
            "tool_name": "read_file",
            "output": "synthetic contents",
        },
    )

    assert response.status_code == 409
    assert response.json()["error"]["error_code"] == "tool_call_mismatch"


def _manager(tmp_path) -> tuple[FusionRunManager, FileSystemRunStore]:
    config = FusionConfig(
        endpoints=[
            ModelEndpoint(id="fast", model="fake-fast", base_url="http://localhost:8101"),
        ],
        default_model="fast",
        default_mode="single",
    )
    engine = FusionEngine(config=config, clients={"fast": FakeModelClient("fast")})
    store = FileSystemRunStore(tmp_path / "runs")
    return FusionRunManager(engine, store, LocalArtifactStore(tmp_path / "runs")), store


def _client(manager: FusionRunManager) -> TestClient:
    config = FusionConfig(
        endpoints=[
            ModelEndpoint(id="fast", model="fake-fast", base_url="http://localhost:8101"),
        ],
        default_model="fast",
        default_mode="single",
    )
    return TestClient(create_app(config, run_manager=manager))


def _request(request_id: str) -> FusionRunRequestV1:
    return FusionRunRequestV1.model_validate(
        {
            **contract_metadata("fusion-run-request.v1"),
            "request_id": request_id,
            "mode": "single",
            "messages": [{"role": "user", "content": "Use a tool"}],
            "sampling": {},
            "verify": False,
            "tool_policy": "external_pause",
        }
    )
