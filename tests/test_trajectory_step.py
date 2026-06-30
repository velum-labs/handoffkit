from __future__ import annotations

from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Any

from fastapi.testclient import TestClient
from fusionkit_core.clients import FakeModelClient
from fusionkit_core.config import FusionConfig, ModelEndpoint, SamplingConfig
from fusionkit_core.types import ChatMessage, ModelResponse, StreamChunk, ToolCall, Usage
from fusionkit_server import create_app


def _config() -> FusionConfig:
    return FusionConfig(
        endpoints=[
            ModelEndpoint(id="judge", model="fake-judge", base_url="http://localhost:8201"),
        ],
        default_model="judge",
        judge_model="judge",
        synthesizer_model="judge",
    )


_TRAJECTORY = {
    "trajectory_id": "t_gpt",
    "model_id": "gpt",
    "status": "succeeded",
    "final_output": "patched add() to use +",
    "steps": [
        {"index": 0, "type": "reasoning", "text": "the operator is wrong"},
        {"index": 1, "type": "output", "text": "done"},
    ],
}


def test_step_returns_final_answer_when_no_tool_calls(tmp_path) -> None:
    app = create_app(
        _config(),
        clients={"judge": FakeModelClient("judge", ["done: the bug is fixed"])},
        run_store_path=tmp_path / "runs",
    )
    client = TestClient(app)

    response = client.post(
        "/v1/fusion/trajectories:fuse",
        json={
            "messages": [{"role": "user", "content": "fix the add() bug"}],
            "trajectories": [_TRAJECTORY],
        },
    )

    assert response.status_code == 200
    body = response.json()
    choice = body["choices"][0]
    assert choice["message"]["content"] == "done: the bug is fixed"
    assert "tool_calls" not in choice["message"]
    assert choice["finish_reason"] == "stop"
    # Terminal step: the fused output is a trajectory carrying its synthesis.
    synthesis = body["fusion"]["trajectory"]["synthesis"]
    assert synthesis["decision"] == "synthesize"
    assert synthesis["input_trajectory_ids"] == ["t_gpt"]


class _ToolCallClient:
    """A judge client that always proposes one tool call (executor-style step)."""

    model_id = "judge"

    def __init__(self) -> None:
        self.seen_tools: Sequence[Mapping[str, Any]] | None = None
        self.system_prompt = ""

    async def chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[Mapping[str, Any]] | None = None,
        tool_choice: str | Mapping[str, Any] | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> ModelResponse:
        self.seen_tools = tools
        self.system_prompt = next(
            (message.content for message in messages if message.role == "system"), ""
        )
        return ModelResponse(
            model_id="judge",
            content="",
            finish_reason="tool_calls",
            usage=Usage(prompt_tokens=10, completion_tokens=2, total_tokens=12),
            tool_calls=[
                ToolCall(id="call_1", name="write_file", arguments='{"path": "calculator.js"}')
            ],
        )

    async def stream_chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[Mapping[str, Any]] | None = None,
        tool_choice: str | Mapping[str, Any] | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> AsyncIterator[StreamChunk]:
        self.seen_tools = tools
        self.system_prompt = next(
            (message.content for message in messages if message.role == "system"), ""
        )
        # The synthesizer step proposes a tool call mid-stream (id+name in the
        # opening fragment, arguments follow), then finishes with tool_calls.
        yield StreamChunk(
            tool_call_delta=ToolCall(id="call_1", name="write_file", arguments="")
        )
        yield StreamChunk(
            tool_call_delta=ToolCall(id="call_1", name="", arguments='{"path": "calculator.js"}')
        )
        yield StreamChunk(finish_reason="tool_calls")

    async def aclose(self) -> None:
        return None


def test_step_emits_tool_calls_and_injects_candidate_context(tmp_path) -> None:
    judge = _ToolCallClient()
    app = create_app(_config(), clients={"judge": judge}, run_store_path=tmp_path / "runs")
    client = TestClient(app)

    response = client.post(
        "/v1/fusion/trajectories:fuse",
        json={
            "messages": [{"role": "user", "content": "fix the add() bug"}],
            "trajectories": [_TRAJECTORY],
            "tools": [
                {
                    "name": "write_file",
                    "description": "write a file",
                    "parameters": {"type": "object", "properties": {}},
                }
            ],
        },
    )

    assert response.status_code == 200
    body = response.json()
    choice = body["choices"][0]
    assert choice["finish_reason"] == "tool_calls"
    tool_calls = choice["message"]["tool_calls"]
    assert tool_calls[0]["function"]["name"] == "write_file"
    # The harness tools were forwarded to the judge, and candidate trajectories
    # were injected into the judge's system context.
    assert judge.seen_tools is not None and judge.seen_tools[0]["name"] == "write_file"
    assert "patched add() to use +" in judge.system_prompt


def test_step_streams_sse_with_tool_calls(tmp_path) -> None:
    app = create_app(
        _config(), clients={"judge": _ToolCallClient()}, run_store_path=tmp_path / "runs"
    )
    client = TestClient(app)

    response = client.post(
        "/v1/fusion/trajectories:fuse",
        json={
            "messages": [{"role": "user", "content": "fix"}],
            "trajectories": [_TRAJECTORY],
            "tools": [{"name": "write_file", "parameters": {"type": "object", "properties": {}}}],
            "stream": True,
        },
    )

    assert response.status_code == 200
    assert "text/event-stream" in response.headers["content-type"]
    assert "write_file" in response.text
    assert "data: [DONE]" in response.text
