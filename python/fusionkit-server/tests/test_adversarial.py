from __future__ import annotations

import random
from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Any

import pytest
from fastapi.testclient import TestClient
from fusionkit_core.config import FusionConfig, SamplingConfig
from fusionkit_core.types import ChatMessage, ModelResponse, StreamChunk
from fusionkit_server import create_app


class _NeverCalledClient:
    model_id = "judge"
    max_context: int | None = None

    async def chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[Mapping[str, Any]] | None = None,
        tool_choice: str | Mapping[str, Any] | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> ModelResponse:
        raise AssertionError("invalid request reached RouteKit")

    async def stream_chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[Mapping[str, Any]] | None = None,
        tool_choice: str | Mapping[str, Any] | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> AsyncIterator[StreamChunk]:
        raise AssertionError("invalid request reached RouteKit")
        yield StreamChunk()

    async def aclose(self) -> None:
        return None


@pytest.fixture
def client() -> TestClient:
    config = FusionConfig(
        routekit_url="http://routekit.test",
        endpoint_ids=["judge"],
        default_model="judge",
    )
    return TestClient(create_app(config, clients={"judge": _NeverCalledClient()}))


@pytest.mark.parametrize(
    "payload",
    [
        None,
        [],
        {},
        {"messages": []},
        {"messages": [{"role": "bogus", "content": "x"}], "trajectories": []},
        {
            "messages": [{"role": "user", "content": "x"}],
            "trajectories": [
                {
                    "trajectory_id": "failed",
                    "model_id": "opaque",
                    "status": "failed",
                    "final_output": "",
                }
            ],
        },
        {
            "messages": [{"role": "tool", "content": "x"}],
            "trajectories": [
                {
                    "trajectory_id": "a",
                    "model_id": "opaque",
                    "status": "succeeded",
                    "final_output": "x",
                }
            ],
        },
        {
            "messages": [{"role": "user", "content": "x"}],
            "trajectories": [
                {
                    "trajectory_id": "a",
                    "model_id": "opaque",
                    "status": "succeeded",
                    "final_output": "x",
                    "items": [{"index": -1, "type": 42}],
                }
            ],
        },
    ],
)
def test_malformed_internal_fuse_bodies_fail_closed(
    client: TestClient, payload: object
) -> None:
    response = client.post("/v1/fusion/trajectories:fuse", json=payload)

    assert 400 <= response.status_code < 500
    assert response.headers["content-type"].startswith("application/json")


def test_seeded_random_internal_bodies_never_escape_validation(
    client: TestClient,
) -> None:
    rng = random.Random(20260715)
    atoms: list[object] = [None, True, False, 0, -1, 3.14, "", "x", [], {}]

    for _ in range(100):
        payload = {
            rng.choice(["messages", "message", "trajectories", "stream"]): rng.choice(
                atoms
            ),
            rng.choice(["model", "judge_model", "tools", "panel_mode"]): rng.choice(atoms),
        }
        response = client.post("/v1/fusion/trajectories:fuse", json=payload)
        assert 400 <= response.status_code < 500, (payload, response.text)
        assert "Traceback" not in response.text


def test_unknown_endpoint_is_stable_and_does_not_reach_routekit(
    client: TestClient,
) -> None:
    response = client.post(
        "/v1/fusion/trajectories:fuse",
        json={
            "messages": [{"role": "user", "content": "fuse"}],
            "trajectories": [
                {
                    "trajectory_id": "a",
                    "model_id": "opaque",
                    "status": "succeeded",
                    "final_output": "candidate",
                }
            ],
            "judge_model": "not-configured",
        },
    )

    assert response.status_code == 400
    assert response.json()["error"] == {
        "message": "Unknown RouteKit endpoint 'not-configured'.",
        "type": "sidecar_error",
        "code": "unknown_endpoint",
    }
