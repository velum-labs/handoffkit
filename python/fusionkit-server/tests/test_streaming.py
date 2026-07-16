import json
from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Any

from fastapi.testclient import TestClient
from fusionkit_core.clients import FakeModelClient
from fusionkit_core.config import FusionConfig, SamplingConfig
from fusionkit_core.types import ChatMessage, ModelResponse, StreamChunk, ToolCall, Usage
from fusionkit_server import create_app


class _StreamingClient:
    def __init__(
        self,
        model_id: str,
        *,
        response: ModelResponse | None = None,
        chunks: Sequence[StreamChunk] = (),
        stream_error: Exception | None = None,
    ) -> None:
        self.model_id = model_id
        self.max_context: int | None = None
        self.response = response
        self.chunks = list(chunks)
        self.stream_error = stream_error

    async def chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[Mapping[str, Any]] | None = None,
        tool_choice: str | Mapping[str, Any] | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> ModelResponse:
        del messages, sampling, tools, tool_choice, extra
        if self.response is None:
            raise AssertionError(f"unexpected chat call to {self.model_id}")
        return self.response

    async def stream_chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[Mapping[str, Any]] | None = None,
        tool_choice: str | Mapping[str, Any] | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> AsyncIterator[StreamChunk]:
        del messages, sampling, tools, tool_choice, extra
        for chunk in self.chunks:
            yield chunk
        if self.stream_error is not None:
            raise self.stream_error

    async def aclose(self) -> None:
        return None


_ANALYSIS = (
    '{"consensus":["ok"],"contradictions":[],"unique_insights":[],'
    '"coverage_gaps":[],"likely_errors":[],"recommended_final_structure":[]}'
)


def _stream_client(synth: _StreamingClient) -> TestClient:
    judge = _StreamingClient(
        "judge",
        response=ModelResponse(
            model_id="judge",
            content=_ANALYSIS,
            usage=Usage(prompt_tokens=5, completion_tokens=3),
        ),
    )
    config = FusionConfig(
        routekit_url="http://routekit.test",
        endpoint_ids=["judge", "synth"],
        default_model="judge",
        judge_model="judge",
        synthesizer_model="synth",
    )
    return TestClient(create_app(config, clients={"judge": judge, "synth": synth}))


def _payload(**updates: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": "fusion-panel",
        "messages": [{"role": "user", "content": "fuse"}],
        "trajectories": [
            {
                "trajectory_id": "candidate",
                "model_id": "opaque-member",
                "status": "succeeded",
                "final_output": "candidate answer",
                "metadata": {
                    "usage": {
                        "prompt_tokens": 2,
                        "completion_tokens": 1,
                    }
                },
            }
        ],
        "stream": True,
    }
    payload.update(updates)
    return payload


def _sse_payloads(response) -> list[dict[str, Any]]:
    return [
        json.loads(line.removeprefix("data: "))
        for line in response.iter_lines()
        if line.startswith("data: ") and line != "data: [DONE]"
    ]


def test_internal_fuse_streams_openai_neutral_wire() -> None:
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
                        "fused stream",
                    ],
                )
            },
        )
    )

    with client.stream(
        "POST",
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
            "stream": True,
        },
    ) as response:
        lines = [line for line in response.iter_lines() if line.startswith("data: ")]

    assert response.status_code == 200
    assert lines[-1] == "data: [DONE]"
    payloads = [
        json.loads(line.removeprefix("data: "))
        for line in lines[:-1]
    ]
    content = "".join(
        choice.get("delta", {}).get("content", "")
        for payload in payloads
        for choice in payload.get("choices", [])
    )
    assert "fused stream" in content
    assert any("fusion" in payload for payload in payloads)


def test_internal_fuse_streams_reasoning_tools_and_exact_usage() -> None:
    synth = _StreamingClient(
        "synth",
        chunks=[
            StreamChunk(model_reasoning_delta="private thought"),
            StreamChunk(
                tool_call_delta=ToolCall(
                    id="call-read",
                    name="read_file",
                    arguments='{"path":',
                    index=0,
                )
            ),
            StreamChunk(
                tool_call_delta=ToolCall(
                    id="",
                    name="",
                    arguments='"README.md"}',
                    index=0,
                )
            ),
            StreamChunk(
                finish_reason="tool_calls",
                usage=Usage(prompt_tokens=11, completion_tokens=4),
            ),
        ],
    )
    client = _stream_client(synth)

    with client.stream(
        "POST",
        "/v1/fusion/trajectories:fuse",
        json=_payload(
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
    ) as response:
        payloads = _sse_payloads(response)

    assert response.status_code == 200
    deltas = [choice["delta"] for payload in payloads for choice in payload.get("choices", [])]
    assert any("Weighing the candidates" in delta.get("reasoning_content", "") for delta in deltas)
    assert any(delta.get("reasoning") == "private thought" for delta in deltas)
    tool_delta = next(delta for delta in deltas if delta.get("tool_calls"))
    assert tool_delta["tool_calls"][0]["function"] == {
        "name": "read_file",
        "arguments": '{"path":"README.md"}',
    }
    terminal = next(payload for payload in payloads if "usage" in payload)
    assert terminal["usage"] == {
        "prompt_tokens": 16,
        "completion_tokens": 7,
        "total_tokens": 23,
    }
    assert terminal["choices"][0]["finish_reason"] == "tool_calls"


def test_internal_fuse_stream_emits_stable_error_and_done_on_failure() -> None:
    synth = _StreamingClient(
        "synth",
        chunks=[StreamChunk(delta="partial")],
        stream_error=RuntimeError("secret RouteKit detail"),
    )

    with _stream_client(synth).stream(
        "POST",
        "/v1/fusion/trajectories:fuse",
        json=_payload(),
    ) as response:
        lines = [line for line in response.iter_lines() if line.startswith("data: ")]

    assert response.status_code == 200
    assert lines[-1] == "data: [DONE]"
    error = json.loads(lines[-2].removeprefix("data: "))
    assert error == {"error": {"type": "sidecar_error", "code": "fusion_failed"}}
    assert "secret RouteKit detail" not in "".join(lines)
