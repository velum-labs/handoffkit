"""Remaining engine surfaces, end to end: the event-sourced native runs API
(create / inspect / events / idempotency) over the real provider wire, the
``serve-endpoint`` single-model shim as a real child process, and the router
identity handshake the Node CLI's discover-or-spawn reuse depends on.
"""

from __future__ import annotations

import os
from collections.abc import Iterator

import httpx
import pytest
from fastapi.testclient import TestClient
from fusionkit_core.contracts import FusionRunRequestV1, contract_metadata
from fusionkit_server import create_app
from fusionkit_testkit import (
    Behavior,
    EngineProcess,
    ProviderSimulator,
    judge_analysis,
    panel_config,
    script_fused_turn,
    sim_endpoint,
)


@pytest.fixture
def client(provider_sim: ProviderSimulator, tmp_path) -> Iterator[TestClient]:
    config = panel_config(
        provider_sim,
        members=[
            sim_endpoint(provider_sim, id="member-a", model="gpt-run-a", provider="openai"),
            sim_endpoint(provider_sim, id="member-b", model="claude-run-b", provider="anthropic"),
        ],
        judge=sim_endpoint(provider_sim, id="judge", model="gpt-run-judge", provider="openai"),
    )
    with TestClient(create_app(config, run_store_path=tmp_path / "runs")) as test_client:
        yield test_client


def _run_payload(request_id: str) -> dict:
    request = FusionRunRequestV1.model_validate(
        {
            **contract_metadata("fusion-run-request.v1"),
            "request_id": request_id,
            "mode": "panel",
            "messages": [{"role": "user", "content": "explain the fusion run lifecycle"}],
            "sampling": {},
            "requested_models": ["member-a", "member-b"],
        }
    )
    return request.model_dump(mode="json")


# --- the event-sourced native runs API over the real wire ---------------------------


def test_native_run_completes_and_is_fully_inspectable(
    provider_sim: ProviderSimulator, client: TestClient
) -> None:
    script_fused_turn(
        provider_sim,
        candidates={"gpt-run-a": "candidate a", "claude-run-b": "candidate b"},
        judge_model="gpt-run-judge",
        answer="the native run's fused answer",
    )
    created = client.post("/v1/fusion/runs", json=_run_payload("fusion_req_e2e_001"))
    assert created.status_code == 200, created.text
    body = created.json()
    run_id = body["run_id"]
    assert body["state"] == "completed"
    assert body["idempotency_outcome"] == "created"

    summary = client.get(f"/v1/fusion/runs/{run_id}")
    assert summary.status_code == 200
    assert summary.json()["state"] == "completed"

    inspection = client.get(f"/v1/fusion/runs/{run_id}/inspect").json()
    assert inspection["run_id"] == run_id
    # The inspection carries the real fused output produced over the wire.
    assert "the native run's fused answer" in str(inspection)

    events = client.get(f"/v1/fusion/runs/{run_id}/events").json()["events"]
    event_types = [event["event_type"] for event in events]
    # The event-sourced lifecycle: queued -> model calls + trajectories recorded.
    assert event_types[0] == "run_queued"
    assert "model_call_recorded" in event_types
    assert "trajectory_recorded" in event_types
    # Both members really fanned out on their own dialects.
    dialects = {entry["model"]: entry["dialect"] for entry in provider_sim.calls()}
    assert dialects["gpt-run-a"] == "openai-chat"
    assert dialects["claude-run-b"] == "anthropic-messages"


def test_native_run_idempotency_key_replays_the_same_run(
    provider_sim: ProviderSimulator, client: TestClient
) -> None:
    script_fused_turn(
        provider_sim,
        candidates={"gpt-run-a": "a", "claude-run-b": "b"},
        judge_model="gpt-run-judge",
        answer="idempotent answer",
    )
    payload = _run_payload("fusion_req_e2e_002")
    first = client.post("/v1/fusion/runs", json=payload, headers={"Idempotency-Key": "same-key"})
    wire_calls_after_first = len(provider_sim.calls())
    second = client.post("/v1/fusion/runs", json=payload, headers={"Idempotency-Key": "same-key"})
    assert first.status_code == 200 and second.status_code == 200
    assert second.json()["run_id"] == first.json()["run_id"]
    # The replay is served from the run store: not one extra provider call.
    assert len(provider_sim.calls()) == wire_calls_after_first, provider_sim.describe_journal()


def test_native_run_unknown_id_yields_the_canonical_error(client: TestClient) -> None:
    response = client.get("/v1/fusion/runs/run_does_not_exist")
    assert response.status_code == 404
    error = response.json()["error"]
    assert error["error_code"] == "run_not_found"
    assert error["retryable"] is False


# --- serve-endpoint: the single-model shim as a real process --------------------------


def test_serve_endpoint_process_fronts_one_model(provider_sim: ProviderSimulator) -> None:
    os.environ.setdefault("FUSIONKIT_TESTKIT_OPENAI_KEY", "sk-serve-endpoint")
    engine = EngineProcess(
        None,
        command_args=[
            "serve-endpoint",
            "--id",
            "solo",
            "--model",
            "gpt-solo",
            "--provider",
            "openai",
            "--base-url",
            provider_sim.url,
            "--api-key-env",
            "FUSIONKIT_TESTKIT_OPENAI_KEY",
        ],
    )
    with engine, httpx.Client(base_url=engine.url, timeout=30.0) as http:
        models = {entry["id"] for entry in http.get("/v1/models").json()["data"]}
        assert "solo" in models
        provider_sim.queue("gpt-solo", "the solo endpoint answer")
        response = http.post(
            "/v1/chat/completions",
            json={"model": "solo", "messages": [{"role": "user", "content": "hi"}]},
        )
    assert response.status_code == 200
    assert response.json()["choices"][0]["message"]["content"] == "the solo endpoint answer"
    (entry,) = provider_sim.calls(model="gpt-solo")
    assert entry["auth"]["authorization"] == "Bearer sk-serve-endpoint"


# --- the router identity handshake (Node discover-or-spawn reuse) -----------------------


def test_router_identity_rides_health_for_discover_or_spawn(
    provider_sim: ProviderSimulator,
) -> None:
    config = panel_config(
        provider_sim,
        members=[sim_endpoint(provider_sim, id="m", model="gpt-id", provider="openai")],
    )
    engine = EngineProcess(config, env={"FUSIONKIT_ROUTER_IDENTITY": "identity-token-42"})
    with engine, httpx.Client(base_url=engine.url, timeout=10.0) as http:
        health = http.get("/health").json()
    assert health == {"status": "ok", "identity": "identity-token-42"}


def test_fused_alias_works_through_serve_process_with_identity(
    provider_sim: ProviderSimulator,
) -> None:
    # Identity must be inert to actual serving: a fused turn still works.
    members = [
        sim_endpoint(provider_sim, id="m1", model="gpt-i1", provider="openai"),
        sim_endpoint(provider_sim, id="m2", model="claude-i2", provider="anthropic"),
    ]
    judge = sim_endpoint(provider_sim, id="j", model="gpt-ij", provider="openai")
    config = panel_config(provider_sim, members=members, judge=judge)
    provider_sim.queue("gpt-i1", "c1")
    provider_sim.queue("claude-i2", "c2")
    provider_sim.queue("gpt-ij", Behavior(reply=judge_analysis()), "fused with identity set")
    with (
        EngineProcess(config, env={"FUSIONKIT_ROUTER_IDENTITY": "x"}) as engine,
        httpx.Client(base_url=engine.url, timeout=60.0) as http,
    ):
        response = http.post(
            "/v1/chat/completions",
            json={
                "model": "fusionkit/panel",
                "messages": [{"role": "user", "content": "go"}],
            },
        )
    assert response.status_code == 200
    assert response.json()["choices"][0]["message"]["content"] == "fused with identity set"
