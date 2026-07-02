"""Upstream model reasoning (`reasoning` / `reasoning_content`) passthrough.

Local MLX serves thinking text on ``message.reasoning`` / ``delta.reasoning``;
vLLM-style servers use ``reasoning_content``. The router must preserve both:
the client normalizes them onto ``ModelResponse.reasoning`` /
``StreamChunk.model_reasoning_delta``, and the server re-emits them on the
OpenAI wire (``reasoning_content`` non-stream, ``reasoning`` for token deltas).
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

from fusionkit_core.clients import OpenAICompatibleClient
from fusionkit_core.config import ModelEndpoint
from fusionkit_core.judge import FuseResult
from fusionkit_core.types import ChatMessage, FusionAnalysis, ModelResponse, StreamChunk
from fusionkit_server.app import _fused_completion_sse, _openai_step_response


def _endpoint() -> ModelEndpoint:
    return ModelEndpoint(
        id="local",
        provider="openai-compatible",
        model="mlx-community/Qwen3-8B-4bit",
        base_url="https://example.test",
    )


async def _aiter(items: list[Any]) -> AsyncIterator[Any]:
    for item in items:
        yield item


# --- client normalization ----------------------------------------------------


async def test_openai_chat_reads_reasoning_field() -> None:
    client = OpenAICompatibleClient(_endpoint())
    response_obj = SimpleNamespace(
        choices=[
            SimpleNamespace(
                message=SimpleNamespace(
                    content="the answer", reasoning="thought first", tool_calls=None
                ),
                finish_reason="stop",
            )
        ],
        usage=None,
        model_dump=lambda mode="json": {"ok": True},
    )
    client._client.chat.completions.create = AsyncMock(return_value=response_obj)

    response = await client.chat([ChatMessage(role="user", content="hi")])

    assert response.content == "the answer"
    assert response.reasoning == "thought first"


async def test_openai_chat_reads_vllm_reasoning_content_field() -> None:
    client = OpenAICompatibleClient(_endpoint())
    response_obj = SimpleNamespace(
        choices=[
            SimpleNamespace(
                message=SimpleNamespace(
                    content="answer", reasoning_content="vllm thought", tool_calls=None
                ),
                finish_reason="stop",
            )
        ],
        usage=None,
        model_dump=lambda mode="json": {"ok": True},
    )
    client._client.chat.completions.create = AsyncMock(return_value=response_obj)

    response = await client.chat([ChatMessage(role="user", content="hi")])

    assert response.reasoning == "vllm thought"


async def test_openai_stream_chat_carries_model_reasoning_delta() -> None:
    client = OpenAICompatibleClient(_endpoint())
    events = [
        SimpleNamespace(
            choices=[
                SimpleNamespace(
                    delta=SimpleNamespace(content=None, reasoning="Let me", tool_calls=None),
                    finish_reason=None,
                )
            ],
            usage=None,
        ),
        SimpleNamespace(
            choices=[
                SimpleNamespace(
                    delta=SimpleNamespace(content="ok", tool_calls=None),
                    finish_reason="stop",
                )
            ],
            usage=None,
        ),
    ]
    client._client.chat.completions.create = AsyncMock(return_value=_aiter(events))

    chunks = [chunk async for chunk in client.stream_chat([ChatMessage(role="user", content="hi")])]

    assert chunks[0].model_reasoning_delta == "Let me"
    assert chunks[0].delta == ""
    assert chunks[1].model_reasoning_delta is None
    assert chunks[1].delta == "ok"


# --- server wire emission ----------------------------------------------------


def _response(reasoning: str | None) -> ModelResponse:
    return ModelResponse(model_id="local", content="answer", reasoning=reasoning)


def test_openai_step_response_surfaces_reasoning_content() -> None:
    payload = _openai_step_response("local", _response("thought"))
    message = payload["choices"][0]["message"]
    assert message["reasoning_content"] == "thought"
    assert message["content"] == "answer"

    bare = _openai_step_response("local", _response(None))
    assert "reasoning_content" not in bare["choices"][0]["message"]


async def test_fused_completion_sse_emits_model_reasoning_on_reasoning_field() -> None:
    async def stream() -> AsyncIterator[StreamChunk | FuseResult]:
        yield StreamChunk(model_reasoning_delta="Let me")
        yield StreamChunk(model_reasoning_delta=" think.")
        yield StreamChunk(delta="answer")
        yield FuseResult(response=_response(None), terminal=True, analysis=FusionAnalysis())

    body = "".join([part async for part in _fused_completion_sse("local", stream())])
    deltas = [
        json.loads(line[len("data: ") :])["choices"][0]["delta"]
        for line in body.splitlines()
        if line.startswith("data: ") and line != "data: [DONE]"
    ]
    reasoning = "".join(delta.get("reasoning", "") for delta in deltas)
    content = "".join(delta.get("content", "") for delta in deltas)
    assert reasoning == "Let me think."
    assert content == "answer"
    # Token deltas ride `reasoning`, never the narration-beat field.
    assert all("reasoning_content" not in delta for delta in deltas)
