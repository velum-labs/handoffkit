from __future__ import annotations

import json
from collections.abc import AsyncIterator

import httpx
import pytest
from fusionkit_core.routekit_client import RouteKitClient
from fusionkit_core.types import ChatMessage


class _ChunkedBody(httpx.AsyncByteStream):
    def __init__(self, body: bytes, chunk_size: int) -> None:
        self._body = body
        self._chunk_size = chunk_size

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for start in range(0, len(self._body), self._chunk_size):
            yield self._body[start : start + self._chunk_size]


def _stream_response(body: str, *, chunk_size: int = 64) -> httpx.Response:
    return httpx.Response(
        200,
        headers={"content-type": "text/event-stream"},
        stream=_ChunkedBody(body.encode(), chunk_size),
    )


@pytest.mark.asyncio
async def test_routekit_client_sends_namespaced_model_id_and_parses_tools() -> None:
    observed: dict[str, object] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        observed.update(json.loads(request.content))
        assert request.url.path == "/v1/chat/completions"
        assert "authorization" not in request.headers
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": "",
                            "tool_calls": [
                                {
                                    "id": "call-1",
                                    "type": "function",
                                    "function": {
                                        "name": "read_file",
                                        "arguments": '{"path":"README.md"}',
                                    },
                                }
                            ],
                        },
                        "finish_reason": "tool_calls",
                    }
                ],
                "usage": {
                    "prompt_tokens": 7,
                    "completion_tokens": 3,
                    "total_tokens": 10,
                },
            },
        )

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = RouteKitClient(
        "http://routekit.test",
        "openai/gpt-5.5",
        http_client=http_client,
    )
    try:
        response = await client.chat(
            [ChatMessage(role="user", content="inspect")],
            tools=[
                {
                    "name": "read_file",
                    "description": "Read a file",
                    "parameters": {"type": "object"},
                }
            ],
        )
    finally:
        await http_client.aclose()

    assert observed["model"] == "openai/gpt-5.5"
    assert response.model_id == "openai/gpt-5.5"
    assert response.tool_calls[0].name == "read_file"
    assert response.usage.total_tokens == 10


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "field",
    ["model", "messages", "stream", "stream_options", "tools", "tool_choice"],
)
async def test_routekit_client_rejects_reserved_extra_payload_fields(field: str) -> None:
    http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _: httpx.Response(200))
    )
    client = RouteKitClient(
        "http://routekit.test",
        "opaque-endpoint",
        http_client=http_client,
    )
    try:
        with pytest.raises(ValueError, match=f"cannot override: {field}"):
            await client.chat(
                [ChatMessage(role="user", content="inspect")],
                extra={field: "override"},
            )
    finally:
        await http_client.aclose()


@pytest.mark.asyncio
async def test_routekit_client_parses_streamed_text_reasoning_usage_and_tools() -> None:
    events = [
        {"choices": [{"delta": {"reasoning_content": "think"}, "finish_reason": None}]},
        {"choices": [{"delta": {"content": "answer"}, "finish_reason": None}]},
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call-1",
                                "function": {"name": "read_file", "arguments": '{"path":'},
                            }
                        ]
                    },
                    "finish_reason": None,
                }
            ]
        },
        {
            "choices": [],
            "usage": {
                "prompt_tokens": 4,
                "completion_tokens": 2,
                "total_tokens": 6,
            },
        },
    ]
    content = "".join(f"data: {json.dumps(event)}\n\n" for event in events)
    content += "data: [DONE]\n\n"

    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=content, headers={"content-type": "text/event-stream"})

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = RouteKitClient("http://routekit.test/v1", "opaque", http_client=http_client)
    try:
        chunks = [
            chunk
            async for chunk in client.stream_chat(
                [ChatMessage(role="user", content="stream")]
            )
        ]
    finally:
        await http_client.aclose()

    assert "".join(chunk.delta for chunk in chunks) == "answer"
    assert "".join(chunk.model_reasoning_delta or "" for chunk in chunks) == "think"
    assert chunks[2].tool_call_delta is not None
    assert chunks[2].tool_call_delta.index == 0
    assert chunks[-1].usage is not None
    assert chunks[-1].usage.total_tokens == 6


@pytest.mark.asyncio
@pytest.mark.parametrize("chunk_size", [1, 2, 7, 31])
async def test_stream_is_lossless_across_arbitrary_byte_boundaries(chunk_size: int) -> None:
    answer = "héllo 🌍"
    events = [
        {"choices": [{"delta": {"content": part}, "finish_reason": None}]}
        for part in ["hé", "llo ", "🌍"]
    ]
    body = "".join(f"data: {json.dumps(event, ensure_ascii=False)}\n\n" for event in events)
    body += "data: [DONE]\n\n"
    http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda _: _stream_response(body, chunk_size=chunk_size)
        )
    )
    client = RouteKitClient("http://routekit.test", "opaque", http_client=http_client)
    try:
        chunks = [
            chunk
            async for chunk in client.stream_chat(
                [ChatMessage(role="user", content="stream")]
            )
        ]
    finally:
        await http_client.aclose()

    assert "".join(chunk.delta for chunk in chunks) == answer


@pytest.mark.asyncio
async def test_stream_parses_multiline_sse_data_event() -> None:
    body = (
        'event: completion\n'
        'data: {"choices":[{"delta":{"content":"multi"},\n'
        'data: "finish_reason":null}]}\n\n'
        ": keepalive\n\n"
        "data: [DONE]\n\n"
    )
    http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _: _stream_response(body, chunk_size=3))
    )
    client = RouteKitClient("http://routekit.test", "opaque", http_client=http_client)
    try:
        chunks = [
            chunk
            async for chunk in client.stream_chat(
                [ChatMessage(role="user", content="stream")]
            )
        ]
    finally:
        await http_client.aclose()

    assert [chunk.delta for chunk in chunks] == ["multi"]


@pytest.mark.asyncio
async def test_stream_preserves_multiple_simultaneous_tool_call_fragments() -> None:
    events = [
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call-a",
                                "function": {"name": "read_file", "arguments": '{"path":'},
                            },
                            {
                                "index": 1,
                                "id": "call-b",
                                "function": {"name": "search", "arguments": '{"query":'},
                            },
                        ]
                    },
                    "finish_reason": None,
                }
            ]
        },
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "function": {"arguments": '"README.md"}'},
                            },
                            {
                                "index": 1,
                                "function": {"arguments": '"fusion"}'},
                            },
                        ]
                    },
                    "finish_reason": "tool_calls",
                }
            ]
        },
        {
            "choices": [],
            "usage": {"prompt_tokens": 9, "completion_tokens": 5, "total_tokens": 14},
        },
    ]
    body = "".join(f"data: {json.dumps(event)}\n\n" for event in events)
    body += "data: [DONE]\n\n"
    http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _: _stream_response(body, chunk_size=5))
    )
    client = RouteKitClient("http://routekit.test", "opaque", http_client=http_client)
    try:
        chunks = [
            chunk
            async for chunk in client.stream_chat(
                [ChatMessage(role="user", content="stream")]
            )
        ]
    finally:
        await http_client.aclose()

    fragments = [chunk.tool_call_delta for chunk in chunks if chunk.tool_call_delta]
    assert [(fragment.index, fragment.id, fragment.name) for fragment in fragments[:2]] == [
        (0, "call-a", "read_file"),
        (1, "call-b", "search"),
    ]
    assert [fragment.arguments for fragment in fragments] == [
        '{"path":',
        '{"query":',
        '"README.md"}',
        '"fusion"}',
    ]
    assert chunks[-1].usage is not None
    assert chunks[-1].usage.total_tokens == 14


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("body", "message"),
    [
        ('data: {"choices":[]}\n\n', "ended before"),
        ("data: {not-json}\n\ndata: [DONE]\n\n", "malformed SSE JSON"),
        ('data: {"choices":[\n\ndata: [DONE]\n\n', "malformed SSE JSON"),
    ],
)
async def test_stream_rejects_truncated_or_malformed_sse(body: str, message: str) -> None:
    http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _: _stream_response(body, chunk_size=2))
    )
    client = RouteKitClient("http://routekit.test", "opaque", http_client=http_client)
    try:
        with pytest.raises(ValueError, match=message):
            _ = [
                chunk
                async for chunk in client.stream_chat(
                    [ChatMessage(role="user", content="stream")]
                )
            ]
    finally:
        await http_client.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("field", ["reasoning", "reasoning_content"])
async def test_nonstream_reads_routekit_reasoning_fields(field: str) -> None:
    response = {
        "choices": [
            {
                "message": {"content": "answer", field: "private reasoning"},
                "finish_reason": "stop",
            }
        ]
    }
    http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _: httpx.Response(200, json=response))
    )
    client = RouteKitClient("http://routekit.test", "opaque", http_client=http_client)
    try:
        result = await client.chat([ChatMessage(role="user", content="reason")])
    finally:
        await http_client.aclose()

    assert result.reasoning == "private reasoning"


@pytest.mark.asyncio
async def test_close_only_closes_an_owned_http_client() -> None:
    injected = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _: httpx.Response(200))
    )
    borrowed = RouteKitClient(
        "http://routekit.test", "borrowed", http_client=injected
    )
    owned = RouteKitClient("http://routekit.test", "owned")

    await borrowed.aclose()
    await owned.aclose()

    assert injected.is_closed is False
    assert owned._client.is_closed is True
    await injected.aclose()
