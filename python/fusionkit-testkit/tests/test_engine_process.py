"""Process-level checks for the shipped internal sidecar entrypoint."""

from __future__ import annotations

import json
from typing import Literal

import fusionkit_testkit.engine as engine_module
import httpx
import pytest
from fusionkit_core.config import FusionConfig
from fusionkit_testkit import Behavior, EngineProcess, EngineProcessError, RouteKitSimulator

JUDGE_ANALYSIS = json.dumps(
    {
        "consensus": ["agreement"],
        "contradictions": [],
        "unique_insights": [],
        "coverage_gaps": [],
        "likely_errors": [],
        "recommended_final_structure": [],
    }
)


@pytest.fixture(scope="module")
def stack():
    with RouteKitSimulator() as simulator:
        config = FusionConfig(
            routekit_url=simulator.url,
            endpoint_ids=["judge"],
            default_model="judge",
            judge_model="judge",
            synthesizer_model="judge",
        )
        with EngineProcess(config) as sidecar:
            yield simulator, sidecar


def test_sidecar_process_health_and_route_scope(stack) -> None:
    simulator, sidecar = stack
    del simulator
    with httpx.Client(base_url=sidecar.url, timeout=10.0) as client:
        assert client.get("/health").json() == {"status": "ok"}
        assert client.get("/v1/models").status_code == 404
        assert client.post("/v1/chat/completions", json={}).status_code == 404


def test_sidecar_process_fuses_trajectories_through_routekit(stack) -> None:
    simulator, sidecar = stack
    simulator.queue(
        "judge",
        Behavior(reply=JUDGE_ANALYSIS, prompt_tokens=7, completion_tokens=2),
        Behavior(reply="fused across processes"),
    )
    with httpx.Client(base_url=sidecar.url, timeout=30.0) as client:
        response = client.post(
            "/v1/fusion/trajectories:fuse",
            json={
                "messages": [{"role": "user", "content": "fuse it"}],
                "trajectories": [
                    {
                        "trajectory_id": "candidate-a",
                        "model_id": "opaque-member",
                        "status": "succeeded",
                        "final_output": "candidate A",
                    }
                ],
            },
        )
    assert response.status_code == 200
    assert response.json()["choices"][0]["message"]["content"] == "fused across processes"
    assert [entry["model"] for entry in simulator.calls(model="judge")] == [
        "judge",
        "judge",
    ]


def test_sidecar_process_streams_losslessly_across_routekit_byte_boundaries(stack) -> None:
    simulator, sidecar = stack
    simulator.queue(
        "judge",
        Behavior(reply=JUDGE_ANALYSIS, prompt_tokens=7, completion_tokens=2),
        Behavior(
            reply="héllo fused 🌍",
            reasoning="private thought",
            prompt_tokens=11,
            completion_tokens=5,
            chunk_bytes=1,
        ),
    )
    with httpx.Client(base_url=sidecar.url, timeout=30.0) as client:
        response = client.post(
            "/v1/fusion/trajectories:fuse",
            json={
                "messages": [{"role": "user", "content": "fuse it"}],
                "trajectories": [
                    {
                        "trajectory_id": "candidate-a",
                        "model_id": "opaque-member",
                        "status": "succeeded",
                        "final_output": "candidate A",
                    }
                ],
                "stream": True,
            },
        )

    lines = [line for line in response.text.splitlines() if line.startswith("data: ")]
    payloads = [
        json.loads(line.removeprefix("data: "))
        for line in lines
        if line != "data: [DONE]"
    ]
    content = "".join(
        choice["delta"].get("content", "")
        for payload in payloads
        for choice in payload.get("choices", [])
    )
    assert response.status_code == 200
    assert content == "héllo fused 🌍"
    assert any(
        choice["delta"].get("reasoning") == "private "
        for payload in payloads
        for choice in payload.get("choices", [])
    )
    assert lines[-1] == "data: [DONE]"
    terminal = next(payload for payload in payloads if "usage" in payload)
    assert terminal["usage"]["total_tokens"] == 25


@pytest.mark.parametrize("broken_stream", ["truncate", "garbage"])
def test_sidecar_process_stabilizes_broken_routekit_streams(
    stack,
    broken_stream: Literal["truncate", "garbage"],
) -> None:
    simulator, sidecar = stack
    simulator.queue(
        "judge",
        Behavior(reply=JUDGE_ANALYSIS),
        Behavior(reply="partial output", broken_stream=broken_stream),
    )
    with httpx.Client(base_url=sidecar.url, timeout=30.0) as client:
        response = client.post(
            "/v1/fusion/trajectories:fuse",
            json={
                "messages": [{"role": "user", "content": "fuse it"}],
                "trajectories": [
                    {
                        "trajectory_id": "candidate-a",
                        "model_id": "opaque-member",
                        "status": "succeeded",
                        "final_output": "candidate A",
                    }
                ],
                "stream": True,
            },
        )

    lines = [line for line in response.text.splitlines() if line.startswith("data: ")]
    assert response.status_code == 200
    assert lines[-1] == "data: [DONE]"
    assert json.loads(lines[-2].removeprefix("data: ")) == {
        "error": {"type": "sidecar_error", "code": "fusion_failed"}
    }


def test_sidecar_process_rejects_malformed_fuse_without_routekit_call(stack) -> None:
    simulator, sidecar = stack
    before = len(simulator.journal())
    with httpx.Client(base_url=sidecar.url, timeout=10.0) as client:
        response = client.post(
            "/v1/fusion/trajectories:fuse",
            json={
                "messages": [],
                "trajectories": [{"status": "succeeded"}],
            },
        )

    assert response.status_code == 422
    assert len(simulator.journal()) == before


def test_sidecar_process_startup_failure_carries_the_log(monkeypatch) -> None:
    monkeypatch.setattr(engine_module, "free_port", lambda host="127.0.0.1": 1)
    config = FusionConfig(
        routekit_url="http://127.0.0.1:9",
        endpoint_ids=["judge"],
        default_model="judge",
    )
    broken = EngineProcess(config, startup_timeout_s=30.0)
    try:
        with pytest.raises(EngineProcessError) as excinfo:
            broken.start()
    finally:
        broken.stop()
    assert "engine log" in str(excinfo.value)
