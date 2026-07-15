"""Neutral RouteKit simulator infrastructure self-tests."""

from __future__ import annotations

from typing import Literal

import httpx
import pytest
from fusionkit_core.routekit_client import RouteKitClient
from fusionkit_core.types import ChatMessage
from fusionkit_testkit import Behavior, RouteKitSimulator, SimToolCall


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
                async for chunk in client.stream_chat(
                    [ChatMessage(role="user", content="stream")]
                )
            ]
    finally:
        await client.aclose()
