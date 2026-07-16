from __future__ import annotations

from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Any

from fastapi.testclient import TestClient
from fusionkit_core.clients import ChatClient, FakeModelClient
from fusionkit_core.config import FusionConfig, SamplingConfig
from fusionkit_core.types import ChatMessage, ModelResponse, StreamChunk, ToolCall, Usage
from fusionkit_server import create_app


class _ScriptedClient:
    def __init__(
        self,
        model_id: str,
        responses: Sequence[ModelResponse | Exception],
    ) -> None:
        self.model_id = model_id
        self.max_context: int | None = None
        self._responses = list(responses)
        self.calls: list[list[ChatMessage]] = []

    async def chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[Mapping[str, Any]] | None = None,
        tool_choice: str | Mapping[str, Any] | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> ModelResponse:
        del sampling, tools, tool_choice, extra
        self.calls.append(list(messages))
        response = self._responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response

    async def stream_chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[Mapping[str, Any]] | None = None,
        tool_choice: str | Mapping[str, Any] | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> AsyncIterator[StreamChunk]:
        del messages, sampling, tools, tool_choice, extra
        raise AssertionError("streaming was not expected")
        yield StreamChunk()

    async def aclose(self) -> None:
        return None


_ANALYSIS = (
    '{"consensus":["ok"],"contradictions":[],"unique_insights":[],'
    '"coverage_gaps":[],"likely_errors":[],"recommended_final_structure":[]}'
)


def _fuse_payload(**updates: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": "fusion-panel",
        "messages": [{"role": "user", "content": "fuse"}],
        "trajectories": [
            {
                "trajectory_id": "candidate",
                "model_id": "opaque-member",
                "status": "succeeded",
                "final_output": "candidate answer",
            }
        ],
    }
    payload.update(updates)
    return payload


def _scripted_sidecar(
    judge: _ScriptedClient,
    synth: _ScriptedClient | None = None,
) -> TestClient:
    clients: dict[str, ChatClient] = {"judge": judge}
    endpoint_ids = ["judge"]
    if synth is not None:
        clients["synth"] = synth
        endpoint_ids.append("synth")
    return TestClient(
        create_app(
            FusionConfig(
                routekit_url="http://routekit.test",
                endpoint_ids=endpoint_ids,
                default_model="judge",
                judge_model="judge",
                synthesizer_model="synth" if synth is not None else "judge",
            ),
            clients=clients,
        )
    )


def test_internal_trajectory_fuse_returns_synthesis_extension() -> None:
    config = FusionConfig(
        routekit_url="http://routekit.test",
        endpoint_ids=["judge"],
        default_model="judge",
    )
    client = TestClient(
        create_app(
            config,
            clients={
                "judge": FakeModelClient(
                    "judge",
                    [
                        '{"consensus":["ok"],"contradictions":[],"unique_insights":[],'
                        '"coverage_gaps":[],"likely_errors":[],'
                        '"recommended_final_structure":[]}',
                        "fused answer",
                    ],
                )
            },
        )
    )

    response = client.post(
        "/v1/fusion/trajectories:fuse",
        json={
            "model": "fusion-panel",
            "messages": [{"role": "user", "content": "fuse"}],
            "trajectories": [
                {
                    "trajectory_id": "candidate",
                    "model_id": "opaque-member",
                    "status": "succeeded",
                    "final_output": "candidate answer",
                }
            ],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["choices"][0]["message"]["content"] == "fused answer"
    assert body["fusion"]["trajectory"]["synthesis"]["input_trajectory_ids"] == [
        "candidate"
    ]


def test_internal_fuse_surfaces_reasoning_and_exact_usage() -> None:
    judge = _ScriptedClient(
        "judge",
        [
            ModelResponse(
                model_id="judge",
                content=_ANALYSIS,
                usage=Usage(prompt_tokens=6, completion_tokens=4),
            )
        ],
    )
    synth = _ScriptedClient(
        "synth",
        [
            ModelResponse(
                model_id="synth",
                content="fused answer",
                reasoning="synth private reasoning",
                usage=Usage(prompt_tokens=12, completion_tokens=8),
            )
        ],
    )

    response = _scripted_sidecar(judge, synth).post(
        "/v1/fusion/trajectories:fuse",
        json=_fuse_payload(),
    )

    assert response.status_code == 200
    body = response.json()
    message = body["choices"][0]["message"]
    assert message["content"] == "fused answer"
    assert "Weighing the candidates" in message["reasoning_content"]
    assert "synth private reasoning" in message["reasoning_content"]
    assert body["usage"] == {
        "prompt_tokens": 18,
        "completion_tokens": 12,
        "total_tokens": 30,
    }


def test_internal_fuse_returns_nonterminal_tool_step_verbatim() -> None:
    judge = _ScriptedClient(
        "judge", [ModelResponse(model_id="judge", content=_ANALYSIS)]
    )
    synth = _ScriptedClient(
        "synth",
        [
            ModelResponse(
                model_id="synth",
                content="",
                finish_reason="tool_calls",
                tool_calls=[
                    ToolCall(
                        id="call-read",
                        name="read_file",
                        arguments='{"path":"README.md"}',
                    )
                ],
            )
        ],
    )

    response = _scripted_sidecar(judge, synth).post(
        "/v1/fusion/trajectories:fuse",
        json=_fuse_payload(
            panel_mode="step",
            tools=[
                {
                    "type": "function",
                    "function": {
                        "name": "read_file",
                        "parameters": {"type": "object"},
                    },
                }
            ],
        ),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["choices"][0]["finish_reason"] == "tool_calls"
    assert body["choices"][0]["message"]["tool_calls"] == [
        {
            "id": "call-read",
            "type": "function",
            "function": {
                "name": "read_file",
                "arguments": '{"path":"README.md"}',
            },
        }
    ]
    assert "trajectory" not in body.get("fusion", {})


def test_internal_fuse_rejects_malformed_input_before_routekit_calls() -> None:
    judge = _ScriptedClient(
        "judge", [ModelResponse(model_id="judge", content=_ANALYSIS)]
    )
    client = _scripted_sidecar(judge)

    missing_messages = client.post(
        "/v1/fusion/trajectories:fuse",
        json={"trajectories": _fuse_payload()["trajectories"]},
    )
    failed_only = client.post(
        "/v1/fusion/trajectories:fuse",
        json=_fuse_payload(
            trajectories=[
                {
                    "trajectory_id": "failed",
                    "model_id": "opaque",
                    "status": "failed",
                    "final_output": "",
                }
            ]
        ),
    )

    assert missing_messages.status_code == 422
    assert failed_only.status_code == 422
    assert judge.calls == []


def test_internal_fuse_returns_stable_error_without_exception_details() -> None:
    judge = _ScriptedClient(
        "judge", [ModelResponse(model_id="judge", content=_ANALYSIS)]
    )
    synth = _ScriptedClient("synth", [RuntimeError("secret upstream detail")])

    response = _scripted_sidecar(judge, synth).post(
        "/v1/fusion/trajectories:fuse",
        json=_fuse_payload(),
    )

    assert response.status_code == 502
    assert response.json() == {
        "error": {
            "message": "fusion step failed; see the sidecar logs for details",
            "type": "sidecar_error",
            "code": "fusion_failed",
        }
    }
    assert "secret upstream detail" not in response.text
