from __future__ import annotations

from fastapi.testclient import TestClient
from fusionkit_core.clients import FakeModelClient
from fusionkit_core.config import FusionConfig, ModelEndpoint
from fusionkit_core.contracts import FusionRunRequestV1, contract_metadata
from fusionkit_core.types import ChatMessage
from fusionkit_server import create_app


def test_native_fusion_run_create_state_inspect_and_events(tmp_path) -> None:
    client = _client(tmp_path)
    payload = _request_payload("fusion_req_api_001")

    response = client.post("/v1/fusion/runs", json=payload)

    assert response.status_code == 200
    body = response.json()
    assert body["run_id"]
    assert body["trace_id"]
    assert body["state"] == "completed"
    assert body["status"] == "succeeded"
    assert body["event_cursor"] >= 1
    assert body["idempotency_outcome"] == "created"
    assert body["inspection"]["final_output"] == "fused final answer"

    run_id = body["run_id"]
    state_response = client.get(f"/v1/fusion/runs/{run_id}")
    assert state_response.status_code == 200
    assert state_response.json()["state"] == "completed"

    inspect_response = client.get(f"/v1/fusion/runs/{run_id}/inspect")
    assert inspect_response.status_code == 200
    inspection = inspect_response.json()
    assert inspection["trajectories"]
    assert inspection["model_call_ids"]
    assert inspection["final_output"] == "fused final answer"
    assert inspection["judge_synthesis_record"]["schema"] == "judge-synthesis-record.v1"
    assert inspection["final_output_artifact"]["hash"].startswith("sha256:")

    events_response = client.get(f"/v1/fusion/runs/{run_id}/events")
    assert events_response.status_code == 200
    events = events_response.json()["events"]
    assert events
    after_response = client.get(f"/v1/fusion/runs/{run_id}/events?after=1")
    assert after_response.status_code == 200
    assert all(event["event_seq"] > 1 for event in after_response.json()["events"])


def test_native_fusion_run_idempotency_replay(tmp_path) -> None:
    client = _client(tmp_path)
    payload = _request_payload("fusion_req_api_replay_001")

    first = client.post("/v1/fusion/runs", json=payload, headers={"Idempotency-Key": "same"})
    second = client.post("/v1/fusion/runs", json=payload, headers={"Idempotency-Key": "same"})

    assert first.status_code == 200
    assert second.status_code == 200
    assert second.json()["idempotency_outcome"] == "replayed"
    assert second.json()["run_id"] == first.json()["run_id"]


def test_native_fusion_run_idempotency_conflict_returns_native_error(tmp_path) -> None:
    client = _client(tmp_path)

    first = client.post(
        "/v1/fusion/runs",
        json=_request_payload("fusion_req_api_conflict_001", mode="single"),
        headers={"Idempotency-Key": "conflict"},
    )
    second = client.post(
        "/v1/fusion/runs",
        json=_request_payload("fusion_req_api_conflict_002", mode="panel"),
        headers={"Idempotency-Key": "conflict"},
    )

    assert first.status_code == 200
    assert second.status_code == 409
    error = second.json()["error"]
    assert error["error_kind"] == "validation_error"
    assert error["error_code"] == "idempotency_conflict"
    assert error["retryable"] is False
    assert error["owner"] == "fusionkit"
    assert error["terminal_reason"] == "idempotency_key_reused_with_different_request"


def test_native_fusion_run_missing_run_returns_native_error(tmp_path) -> None:
    client = _client(tmp_path)

    response = client.get("/v1/fusion/runs/missing-run")

    assert response.status_code == 404
    error = response.json()["error"]
    assert error["error_kind"] == "validation_error"
    assert error["error_code"] == "run_not_found"
    assert error["retryable"] is False
    assert error["owner"] == "fusionkit"
    assert error["terminal_reason"] == "unknown_run"


def _client(tmp_path) -> TestClient:
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
    app = create_app(
        config,
        clients={
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
        },
        run_store_path=tmp_path / "runs",
    )
    return TestClient(app)


def _request_payload(request_id: str, mode: str = "panel") -> dict:
    request = FusionRunRequestV1.model_validate(
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
    return request.model_dump(mode="json")
