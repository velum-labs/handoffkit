"""Neutral RouteKit simulator infrastructure self-tests."""

from __future__ import annotations

from typing import Any, Literal

import httpx
import pytest
from fusionkit_core.routekit_client import RouteKitClient
from fusionkit_core.types import ChatMessage
from fusionkit_testkit import Behavior, RouteKitSimulator, SimToolCall, parse_sse

_DIALECT_REQUESTS: list[tuple[str, str, dict[str, Any]]] = [
    (
        "openai-chat",
        "/v1/chat/completions",
        {
            "model": "sim-openai",
            "messages": [{"role": "user", "content": "hello"}],
            "tools": [{"type": "function", "function": {"name": "inspect"}}],
        },
    ),
    (
        "anthropic-messages",
        "/v1/messages",
        {
            "model": "sim-anthropic",
            "messages": [{"role": "user", "content": [{"type": "text", "text": "hello"}]}],
            "tools": [{"name": "inspect", "input_schema": {"type": "object"}}],
            "max_tokens": 100,
        },
    ),
    (
        "google-generate",
        "/v1beta/models/sim-google:generateContent",
        {
            "contents": [{"role": "user", "parts": [{"text": "hello"}]}],
            "tools": [{"functionDeclarations": [{"name": "inspect"}]}],
        },
    ),
    (
        "openai-responses",
        "/v1/responses",
        {
            "model": "sim-responses",
            "input": [{"role": "user", "content": [{"type": "input_text", "text": "hello"}]}],
            "tools": [{"type": "function", "name": "inspect", "parameters": {}}],
        },
    ),
]


def _model_for(dialect: str) -> str:
    return {
        "openai-chat": "sim-openai",
        "anthropic-messages": "sim-anthropic",
        "google-generate": "sim-google",
        "openai-responses": "sim-responses",
    }[dialect]


async def test_default_behavior_echoes_when_nothing_is_queued(
    routekit_sim: RouteKitSimulator,
) -> None:
    client = RouteKitClient(routekit_sim.url, "dflt")
    try:
        response = await client.chat([ChatMessage(role="user", content="ping")])
    finally:
        await client.aclose()
    assert "ping" in response.content
    assert routekit_sim.journal()[0]["source"] == "default"


async def test_tool_calls_behavior_without_declared_tools_fails_loudly(
    routekit_sim: RouteKitSimulator,
) -> None:
    # The realism guardrail: a real model can never call an undeclared tool,
    # so a scripted tool_calls behavior answering a tools-less request must
    # fail the call instead of passing silently (this is what catches an
    # engine that drops the caller's tools).
    routekit_sim.queue(
        "gpt-guard",
        Behavior(tool_calls=[SimToolCall(id="c", name="tool", arguments="{}")]),
    )
    client = RouteKitClient(routekit_sim.url, "gpt-guard")
    try:
        with pytest.raises(httpx.HTTPStatusError):
            await client.chat([ChatMessage(role="user", content="no tools declared")])
    finally:
        await client.aclose()
    (entry,) = routekit_sim.calls(model="gpt-guard")
    assert entry["status"] == 400
    assert entry["error_code"] == "sim_tools_not_declared"


async def test_http_control_plane_scripts_and_observes(
    routekit_sim: RouteKitSimulator,
) -> None:
    async with httpx.AsyncClient(base_url=routekit_sim.url, timeout=5.0) as http:
        queued = await http.post(
            "/__sim/behaviors",
            json={"model": "gpt-http", "behaviors": [{"reply": "scripted over http"}]},
        )
        assert queued.status_code == 200

        client = RouteKitClient(routekit_sim.url, "gpt-http")
        try:
            response = await client.chat([ChatMessage(role="user", content="hi")])
        finally:
            await client.aclose()
        assert response.content == "scripted over http"

        journal = (await http.get("/__sim/journal")).json()["entries"]
        assert journal[0]["model"] == "gpt-http"
        assert journal[0]["source"] == "queued"

        reset = await http.post("/__sim/reset", json={})
        assert reset.status_code == 200
        assert (await http.get("/__sim/journal")).json()["entries"] == []


@pytest.mark.parametrize(("dialect", "path", "request_payload"), _DIALECT_REQUESTS)
async def test_native_json_dialects_share_behaviors_and_normalize_features(
    routekit_sim: RouteKitSimulator,
    dialect: str,
    path: str,
    request_payload: dict[str, Any],
) -> None:
    model = _model_for(dialect)
    routekit_sim.queue(
        model,
        Behavior(
            reply="native answer",
            reasoning="careful thought",
            reasoning_signature="sig-json",
            redacted_thinking="opaque-json",
            tool_calls=[SimToolCall("call-a", "inspect", '{"path":"README.md"}')],
            prompt_tokens=11,
            completion_tokens=7,
        ),
    )
    async with httpx.AsyncClient(base_url=routekit_sim.url, timeout=5.0) as http:
        response = await http.post(path, json=request_payload)
    assert response.status_code == 200
    payload = response.json()
    rendered = response.text
    assert "native answer" in rendered
    assert "careful thought" in rendered
    assert "call-a" in rendered
    assert "inspect" in rendered
    assert "README.md" in rendered
    if dialect == "openai-chat":
        assert payload["usage"]["prompt_tokens"] == 11
        assert payload["usage"]["completion_tokens"] == 7
        assert payload["choices"][0]["message"]["reasoning_content"] == "careful thought"
        assert payload["usage"]["total_tokens"] == 18
    elif dialect == "anthropic-messages":
        assert [block["type"] for block in payload["content"]] == [
            "thinking",
            "redacted_thinking",
            "text",
            "tool_use",
        ]
        assert payload["content"][0]["signature"] == "sig-json"
        assert payload["content"][1]["data"] == "opaque-json"
        assert payload["usage"] == {"input_tokens": 11, "output_tokens": 7}
    elif dialect == "google-generate":
        assert payload["candidates"][0]["content"]["parts"][0]["thought"] is True
        assert payload["usageMetadata"] == {
            "promptTokenCount": 11,
            "candidatesTokenCount": 7,
            "totalTokenCount": 18,
        }
    else:
        assert [item["type"] for item in payload["output"]] == [
            "reasoning",
            "message",
            "function_call",
        ]
        assert payload["usage"]["input_tokens"] == 11
        assert payload["usage"]["output_tokens"] == 7
        assert payload["usage"]["total_tokens"] == 18
    (entry,) = routekit_sim.calls(model=model)
    assert entry["dialect"] == dialect
    assert entry["kind"] == "tool_calls"


@pytest.mark.parametrize(("dialect", "path", "request_payload"), _DIALECT_REQUESTS)
async def test_native_streams_preserve_reasoning_parallel_tools_and_usage(
    routekit_sim: RouteKitSimulator,
    dialect: str,
    path: str,
    request_payload: dict[str, Any],
) -> None:
    model = _model_for(dialect)
    routekit_sim.queue(
        model,
        Behavior(
            reply="streamed answer",
            reasoning="streamed thought",
            reasoning_signature="sig-stream",
            redacted_thinking="opaque-stream",
            tool_calls=[
                SimToolCall("call-a", "inspect", '{"path":"README.md"}'),
                SimToolCall("call-b", "search", '{"query":"fusion"}'),
            ],
            prompt_tokens=13,
            completion_tokens=9,
            chunk_bytes=3,
        ),
    )
    stream_path = (
        path.replace(":generateContent", ":streamGenerateContent") + "?alt=sse"
        if dialect == "google-generate"
        else path
    )
    stream_request = {
        **request_payload,
        "stream": True,
        **({"stream_options": {"include_usage": True}} if dialect == "openai-chat" else {}),
    }
    async with httpx.AsyncClient(base_url=routekit_sim.url, timeout=5.0) as http:
        response = await http.post(stream_path, json=stream_request)
    assert response.status_code == 200
    frames = parse_sse(response.text)
    rendered = response.text
    assert "streamed" in rendered
    assert "call-a" in rendered and "call-b" in rendered
    assert "inspect" in rendered and "search" in rendered
    assert len(frames) > 3
    if dialect == "openai-chat":
        assert frames[-1]["usage"]["total_tokens"] == 22
    elif dialect == "anthropic-messages":
        assert frames[-2]["usage"]["output_tokens"] == 9
        deltas = [
            frame.get("delta", {})
            for frame in frames
            if frame.get("type") == "content_block_delta"
        ]
        assert any(
            delta.get("type") == "signature_delta"
            and delta.get("signature") == "sig-stream"
            for delta in deltas
        )
        assert any(
            frame.get("content_block", {}).get("type") == "redacted_thinking"
            and frame["content_block"].get("data") == "opaque-stream"
            for frame in frames
        )
    elif dialect == "google-generate":
        assert frames[-1]["usageMetadata"]["totalTokenCount"] == 22
    else:
        assert frames[-1]["response"]["usage"]["total_tokens"] == 22
    (entry,) = routekit_sim.calls(model=model)
    assert entry["dialect"] == dialect
    assert entry["stream"] is True
    assert entry["tool_call_names"] == ["inspect", "search"]


@pytest.mark.parametrize("chunk_bytes", [1, 2, 5, 17])
async def test_routekit_stream_survives_pathological_wire_chunking(
    routekit_sim: RouteKitSimulator,
    chunk_bytes: int,
) -> None:
    routekit_sim.queue(
        "chunked",
        Behavior(
            reply="héllo 🌍",
            reasoning="careful thought",
            tool_calls=[
                SimToolCall("call-a", "read_file", '{"path":"README.md"}'),
                SimToolCall("call-b", "search", '{"query":"fusion"}'),
            ],
            prompt_tokens=13,
            completion_tokens=8,
            chunk_bytes=chunk_bytes,
        ),
    )
    client = RouteKitClient(routekit_sim.url, "chunked")
    try:
        chunks = [
            chunk
            async for chunk in client.stream_chat(
                [ChatMessage(role="user", content="stream")],
                tools=[
                    {"name": "read_file"},
                    {"name": "search"},
                ],
            )
        ]
    finally:
        await client.aclose()

    assert "".join(chunk.delta for chunk in chunks) == "héllo 🌍"
    assert "".join(chunk.model_reasoning_delta or "" for chunk in chunks) == "careful thought"
    tool_fragments = [
        chunk.tool_call_delta for chunk in chunks if chunk.tool_call_delta is not None
    ]
    assert {fragment.index for fragment in tool_fragments} == {0, 1}
    assert chunks[-1].usage is not None
    assert chunks[-1].usage.total_tokens == 21


@pytest.mark.parametrize("broken_stream", ["truncate", "garbage"])
async def test_broken_routekit_streams_fail_visibly(
    routekit_sim: RouteKitSimulator,
    broken_stream: Literal["truncate", "garbage"],
) -> None:
    routekit_sim.queue(
        "broken",
        Behavior(reply="partial answer", broken_stream=broken_stream),
    )
    client = RouteKitClient(routekit_sim.url, "broken")
    try:
        with pytest.raises((ValueError, httpx.RemoteProtocolError)):
            _ = [
                chunk
                async for chunk in client.stream_chat([ChatMessage(role="user", content="stream")])
            ]
    finally:
        await client.aclose()
