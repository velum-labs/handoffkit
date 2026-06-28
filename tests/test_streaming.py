from __future__ import annotations

import json
from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Any

from fastapi.testclient import TestClient
from fusionkit_core.clients import FakeModelClient, ProviderCallError
from fusionkit_core.config import FusionConfig, FusionMode, ModelEndpoint, SamplingConfig
from fusionkit_core.types import ChatMessage, ModelResponse, StreamChunk, ToolCall, Usage
from fusionkit_server import create_app
from fusionkit_server.openai_endpoint import _astream_sse


def _sse_chunks(body: str) -> list[dict[str, Any]]:
    chunks: list[dict[str, Any]] = []
    for line in body.splitlines():
        if not line.startswith("data: ") or line == "data: [DONE]":
            continue
        chunks.append(json.loads(line[len("data: ") :]))
    return chunks


def _streamed_text(chunks: list[dict[str, Any]]) -> str:
    return "".join(
        chunk["choices"][0]["delta"].get("content", "")
        for chunk in chunks
        if "error" not in chunk
    )


def _config(default_mode: FusionMode = "panel") -> FusionConfig:
    return FusionConfig(
        endpoints=[
            ModelEndpoint(id="m1", model="fake-m1", base_url="http://localhost:8101"),
            ModelEndpoint(id="judge", model="fake-judge", base_url="http://localhost:8201"),
        ],
        default_model="m1",
        judge_model="judge",
        synthesizer_model="judge",
        default_mode=default_mode,
        panel_models=["m1"],
    )


class _ScriptedToolClient:
    """Emits a tool call until a tool result is in the conversation, then answers.

    Models real OpenAI Chat Completions tool semantics: the model asks for a tool
    on turn 1, and once the caller posts the ``tool`` result back it produces the
    final answer. Used as both a panel member and the synthesizer.
    """

    def __init__(self, model_id: str) -> None:
        self.model_id = model_id

    @staticmethod
    def _has_tool_result(messages: Sequence[ChatMessage]) -> bool:
        return any(message.role == "tool" for message in messages)

    async def chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[Mapping[str, Any]] | None = None,
        tool_choice: str | Mapping[str, Any] | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> ModelResponse:
        if self._has_tool_result(messages):
            return ModelResponse(
                model_id=self.model_id,
                content="It is sunny in SF.",
                finish_reason="stop",
                usage=Usage(prompt_tokens=5, completion_tokens=5, total_tokens=10),
            )
        return ModelResponse(
            model_id=self.model_id,
            content="",
            finish_reason="tool_calls",
            usage=Usage(prompt_tokens=5, completion_tokens=2, total_tokens=7),
            tool_calls=[ToolCall(id="call_1", name="get_weather", arguments='{"city": "sf"}')],
        )

    async def stream_chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[Mapping[str, Any]] | None = None,
        tool_choice: str | Mapping[str, Any] | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> AsyncIterator[StreamChunk]:
        if self._has_tool_result(messages):
            for token in ("It ", "is ", "sunny."):
                yield StreamChunk(delta=token)
            yield StreamChunk(finish_reason="stop")
            return
        # Tool call split across fragments (id+name first, then arguments).
        yield StreamChunk(tool_call_delta=ToolCall(id="call_1", name="get_weather", arguments=""))
        yield StreamChunk(
            tool_call_delta=ToolCall(id="call_1", name="", arguments='{"city": "sf"}')
        )
        yield StreamChunk(finish_reason="tool_calls")

    async def aclose(self) -> None:
        return None


# --- real SSE streaming shape ----------------------------------------------


def test_passthrough_streaming_is_real_token_stream(tmp_path) -> None:
    app = create_app(
        _config(),
        clients={
            "m1": FakeModelClient("m1", ["hello there from passthrough"]),
            "judge": FakeModelClient("judge"),
        },
        run_store_path=tmp_path / "runs",
    )
    client = TestClient(app)

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "m1",
            "messages": [{"role": "user", "content": "hi"}],
            "stream": True,
        },
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.text.rstrip().endswith("data: [DONE]")
    chunks = _sse_chunks(response.text)
    assert chunks[0]["choices"][0]["delta"] == {"role": "assistant"}
    # The provider streamed multiple tokens (not one buffered blob).
    content_deltas = [c for c in chunks if c["choices"][0]["delta"].get("content")]
    assert len(content_deltas) > 1
    assert _streamed_text(chunks) == "hello there from passthrough "
    assert chunks[-1]["choices"][0]["finish_reason"] == "stop"


def test_fused_streaming_streams_synthesizer_and_carries_fusion_metadata(tmp_path) -> None:
    app = create_app(
        _config(),
        clients={
            "m1": FakeModelClient("m1", ["candidate answer"]),
            "judge": FakeModelClient("judge", ["fused streamed answer"]),
        },
        run_store_path=tmp_path / "runs",
    )
    client = TestClient(app)

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "fusionkit/panel",
            "messages": [{"role": "user", "content": "compare options"}],
            "stream": True,
        },
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    body = response.text
    assert body.rstrip().endswith("data: [DONE]")
    chunks = _sse_chunks(body)
    assert _streamed_text(chunks) == "fused streamed answer "
    terminal = chunks[-1]
    assert terminal["choices"][0]["finish_reason"] == "stop"
    # The fused trajectory metadata rides on the terminal chunk.
    assert terminal["fusion"]["trajectory"]["synthesis"]["decision"] in (
        "synthesize",
        "select_trajectory",
    )
    # WS7: the synthesizer turn's token usage rides the terminal chunk so the
    # gateway cost meter can price a fused *stream* (not just the non-streaming
    # response). The FakeModelClient reports completion_tokens = word count.
    assert terminal["usage"]["completion_tokens"] == len(["fused", "streamed", "answer"])


class _AnthropicShapedStreamClient:
    """Synthesizer whose stream reports usage the way the fixed Anthropic client
    does: ``prompt_tokens`` (from ``message_start``) plus ``completion_tokens``
    (from ``message_delta``) on the terminal chunk."""

    def __init__(self, model_id: str) -> None:
        self.model_id = model_id

    async def chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[Mapping[str, Any]] | None = None,
        tool_choice: str | Mapping[str, Any] | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> ModelResponse:
        # Used for the judge analyze() call.
        return ModelResponse(
            model_id=self.model_id,
            content="{}",
            finish_reason="stop",
            usage=Usage(prompt_tokens=7, completion_tokens=1, total_tokens=8),
        )

    async def stream_chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[Mapping[str, Any]] | None = None,
        tool_choice: str | Mapping[str, Any] | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> AsyncIterator[StreamChunk]:
        for token in ("fused ", "answer"):
            yield StreamChunk(delta=token)
        yield StreamChunk(
            finish_reason="end_turn",
            usage=Usage(prompt_tokens=11, completion_tokens=5, total_tokens=16),
        )

    async def aclose(self) -> None:
        return None


def test_fused_streaming_terminal_chunk_carries_prompt_tokens(tmp_path) -> None:
    # Regression: a fused stream whose synthesizer is Anthropic-shaped must carry
    # `prompt_tokens` on the terminal SSE usage so the Node gateway cost meter
    # (which reads usage off the SSE tail) does not under-report a fused turn.
    app = create_app(
        _config(),
        clients={
            "m1": FakeModelClient("m1", ["candidate answer"]),
            "judge": _AnthropicShapedStreamClient("judge"),
        },
        run_store_path=tmp_path / "runs",
    )
    client = TestClient(app)

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "fusionkit/panel",
            "messages": [{"role": "user", "content": "compare options"}],
            "stream": True,
        },
    )

    assert response.status_code == 200
    chunks = _sse_chunks(response.text)
    terminal = chunks[-1]
    assert terminal["usage"]["prompt_tokens"] == 11
    assert terminal["usage"]["completion_tokens"] == 5
    assert terminal["usage"]["total_tokens"] == 16


def test_fused_streaming_emits_tool_calls(tmp_path) -> None:
    app = create_app(
        _config(),
        clients={"m1": _ScriptedToolClient("m1"), "judge": _ScriptedToolClient("judge")},
        run_store_path=tmp_path / "runs",
    )
    client = TestClient(app)

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "fusionkit/panel",
            "messages": [{"role": "user", "content": "weather in sf?"}],
            "stream": True,
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "get_weather",
                        "parameters": {"type": "object", "properties": {}},
                    },
                }
            ],
        },
    )

    assert response.status_code == 200
    chunks = _sse_chunks(response.text)
    tool_chunk = next(c for c in chunks if c["choices"][0]["delta"].get("tool_calls"))
    call = tool_chunk["choices"][0]["delta"]["tool_calls"][0]
    assert call["index"] == 0
    assert call["function"]["name"] == "get_weather"
    assert json.loads(call["function"]["arguments"]) == {"city": "sf"}
    assert chunks[-1]["choices"][0]["finish_reason"] == "tool_calls"
    assert response.text.rstrip().endswith("data: [DONE]")


# --- tool calling round-trip through the ensemble ---------------------------


def test_tool_call_round_trip_through_fusion(tmp_path) -> None:
    app = create_app(
        _config(),
        clients={"m1": _ScriptedToolClient("m1"), "judge": _ScriptedToolClient("judge")},
        run_store_path=tmp_path / "runs",
    )
    client = TestClient(app)

    tools = [
        {
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "Get weather",
                "parameters": {"type": "object", "properties": {"city": {"type": "string"}}},
            },
        }
    ]

    # Turn 1: the ensemble asks the caller to run a tool.
    first = client.post(
        "/v1/chat/completions",
        json={
            "model": "fusionkit/panel",
            "messages": [{"role": "user", "content": "weather in sf?"}],
            "tools": tools,
        },
    )
    assert first.status_code == 200
    first_choice = first.json()["choices"][0]
    assert first_choice["finish_reason"] == "tool_calls"
    tool_calls = first_choice["message"]["tool_calls"]
    assert tool_calls[0]["function"]["name"] == "get_weather"
    tool_call_id = tool_calls[0]["id"]

    # Turn 2: caller posts the tool result back as a standard `tool` message; the
    # ensemble produces the final answer (OpenAI Chat Completions tool semantics).
    second = client.post(
        "/v1/chat/completions",
        json={
            "model": "fusionkit/panel",
            "messages": [
                {"role": "user", "content": "weather in sf?"},
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": tool_calls,
                },
                {"role": "tool", "tool_call_id": tool_call_id, "content": "72F and sunny"},
            ],
            "tools": tools,
        },
    )
    assert second.status_code == 200
    second_choice = second.json()["choices"][0]
    assert second_choice["finish_reason"] == "stop"
    assert "tool_calls" not in second_choice["message"]
    assert second_choice["message"]["content"] == "It is sunny in SF."


def test_fuse_endpoint_round_trips_tool_result(tmp_path) -> None:
    # The trajectories:fuse step accepts a tool result message and produces the
    # terminal fused answer (the harness-driven tool loop).
    app = create_app(
        _config(),
        clients={"m1": _ScriptedToolClient("m1"), "judge": _ScriptedToolClient("judge")},
        run_store_path=tmp_path / "runs",
    )
    client = TestClient(app)

    response = client.post(
        "/v1/fusion/trajectories:fuse",
        json={
            "model": "fusionkit/panel",
            "messages": [
                {"role": "user", "content": "weather in sf?"},
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "type": "function",
                            "function": {"name": "get_weather", "arguments": "{}"},
                        }
                    ],
                },
                {"role": "tool", "tool_call_id": "call_1", "content": "72F and sunny"},
            ],
            "trajectories": [
                {
                    "trajectory_id": "t1",
                    "model_id": "m1",
                    "status": "succeeded",
                    "final_output": "weather looks sunny",
                }
            ],
            "tools": [{"name": "get_weather", "parameters": {"type": "object", "properties": {}}}],
        },
    )

    assert response.status_code == 200
    choice = response.json()["choices"][0]
    assert choice["finish_reason"] == "stop"
    assert choice["message"]["content"] == "It is sunny in SF."


# --- classified provider failures at the server boundary -------------------


class _RaisingClient:
    """A client whose chat (and stream) raises a classified provider error."""

    def __init__(self, model_id: str, error: ProviderCallError) -> None:
        self.model_id = model_id
        self._error = error

    async def chat(self, *args: Any, **kwargs: Any) -> ModelResponse:
        raise self._error

    async def stream_chat(self, *args: Any, **kwargs: Any) -> AsyncIterator[StreamChunk]:
        raise self._error
        yield StreamChunk()  # unreachable; makes this an async generator

    async def aclose(self) -> None:
        return None


def test_passthrough_provider_error_surfaces_category(tmp_path) -> None:
    error = ProviderCallError(
        "rate limited", category="transient", provider="openai", status_code=429, retry_after=3
    )
    app = create_app(
        _config(),
        clients={"m1": _RaisingClient("m1", error), "judge": FakeModelClient("judge")},
        run_store_path=tmp_path / "runs",
    )
    client = TestClient(app)

    response = client.post(
        "/v1/chat/completions",
        json={"model": "m1", "messages": [{"role": "user", "content": "hi"}]},
    )

    # transient -> 503; the category/provider/retry_after surface verbatim so a
    # failover layer can branch without re-parsing the upstream error.
    assert response.status_code == 503
    body = response.json()["error"]
    assert body["category"] == "transient"
    assert body["provider"] == "openai"
    assert body["retry_after"] == 3.0


def test_streaming_surfaces_provider_error_event(tmp_path) -> None:
    error = ProviderCallError(
        "overloaded", category="transient", provider="anthropic", status_code=529
    )
    app = create_app(
        _config(),
        clients={"m1": _RaisingClient("m1", error), "judge": FakeModelClient("judge")},
        run_store_path=tmp_path / "runs",
    )
    client = TestClient(app)

    response = client.post(
        "/v1/chat/completions",
        json={"model": "m1", "messages": [{"role": "user", "content": "hi"}], "stream": True},
    )

    assert response.status_code == 200
    chunks = _sse_chunks(response.text)
    error_chunk = next(chunk for chunk in chunks if "error" in chunk)
    assert error_chunk["error"]["category"] == "transient"
    assert error_chunk["error"]["provider"] == "anthropic"
    assert response.text.rstrip().endswith("data: [DONE]")


# --- single-endpoint (serve-endpoint) shim streaming -----------------------


async def test_serve_endpoint_shim_streams_real_tokens() -> None:
    client = FakeModelClient("solo", ["alpha beta gamma"])
    sse = [
        piece
        async for piece in _astream_sse(
            client, "solo-model", [ChatMessage(role="user", content="hi")], SamplingConfig(),
            None, None,
        )
    ]

    text = "".join(sse)
    chunks = _sse_chunks(text)
    content_deltas = [c for c in chunks if c["choices"][0]["delta"].get("content")]
    assert len(content_deltas) > 1
    assert _streamed_text(chunks) == "alpha beta gamma "
    assert chunks[-1]["choices"][0]["finish_reason"] == "stop"
    assert text.rstrip().endswith("data: [DONE]")


async def test_serve_endpoint_shim_streams_tool_calls() -> None:
    sse = [
        piece
        async for piece in _astream_sse(
            _ScriptedToolClient("solo"),
            "solo-model",
            [ChatMessage(role="user", content="weather in sf?")],
            SamplingConfig(),
            [{"name": "get_weather", "parameters": {"type": "object", "properties": {}}}],
            "auto",
        )
    ]

    chunks = _sse_chunks("".join(sse))
    tool_chunk = next(c for c in chunks if c["choices"][0]["delta"].get("tool_calls"))
    call = tool_chunk["choices"][0]["delta"]["tool_calls"][0]
    assert call["function"]["name"] == "get_weather"
    assert json.loads(call["function"]["arguments"]) == {"city": "sf"}
    assert chunks[-1]["choices"][0]["finish_reason"] == "tool_calls"
