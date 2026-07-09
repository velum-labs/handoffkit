"""Simulator self-tests for the Google GenAI and OpenAI Responses (codex)
dialects: the REAL ``GoogleModelClient`` / ``CodexResponsesClient`` must parse
the simulated wire exactly as they would the real providers'. Together with
the OpenAI/Anthropic suite this covers every provider client family FusionKit
ships.
"""

from __future__ import annotations

import pytest
from fusionkit_core.clients import ProviderCallError, build_client
from fusionkit_core.types import ChatMessage, ToolCall
from fusionkit_testkit import (
    Behavior,
    ProviderSimulator,
    SimError,
    SimToolCall,
    sim_endpoint,
)


def _google_client(sim: ProviderSimulator):
    return build_client(sim_endpoint(sim, id="google-ep", model="gemini-sim", provider="google"))


def _codex_client(sim: ProviderSimulator):
    return build_client(sim_endpoint(sim, id="codex-ep", model="gpt-codex-sim", provider="codex"))


# --- Google Gemini dialect ------------------------------------------------------


async def test_google_chat_roundtrip_with_journal(provider_sim: ProviderSimulator) -> None:
    provider_sim.queue(
        "gemini-sim",
        Behavior(reply="gemini says hi", reasoning="a thought", prompt_tokens=9),
    )
    client = _google_client(provider_sim)
    try:
        response = await client.chat([ChatMessage(role="user", content="hello gemini")])
    finally:
        await client.aclose()
    assert response.content == "gemini says hi"
    assert response.reasoning == "a thought"
    assert response.usage.prompt_tokens == 9

    (entry,) = provider_sim.calls(dialect="google-generate")
    assert entry["model"] == "gemini-sim"
    assert entry["stream"] is False
    assert entry["auth"]["x_goog_api_key"] == "sk-test-google-ep"


async def test_google_tool_calls_roundtrip(provider_sim: ProviderSimulator) -> None:
    provider_sim.queue(
        "gemini-sim",
        Behavior(tool_calls=[SimToolCall(id="fn_1", name="lookup", arguments='{"q": "x"}')]),
    )
    client = _google_client(provider_sim)
    try:
        response = await client.chat(
            [ChatMessage(role="user", content="lookup x")],
            tools=[{"name": "lookup", "parameters": {"type": "object"}}],
        )
    finally:
        await client.aclose()
    assert response.tool_calls == [ToolCall(id="fn_1", name="lookup", arguments='{"q": "x"}')]


async def test_google_streaming_text_and_usage(provider_sim: ProviderSimulator) -> None:
    provider_sim.queue("gemini-sim", Behavior(reply="streaming from gemini", prompt_tokens=5))
    client = _google_client(provider_sim)
    text: list[str] = []
    terminal_usage = None
    try:
        async for chunk in client.stream_chat([ChatMessage(role="user", content="go")]):
            text.append(chunk.delta)
            if chunk.usage is not None:
                terminal_usage = chunk.usage
    finally:
        await client.aclose()
    assert "".join(text) == "streaming from gemini"
    assert terminal_usage is not None and terminal_usage.prompt_tokens == 5
    assert provider_sim.calls(dialect="google-generate")[0]["stream"] is True


async def test_google_rate_limit_classification(provider_sim: ProviderSimulator) -> None:
    provider_sim.queue("gemini-sim", Behavior(error=SimError.invalid_api_key()))
    client = _google_client(provider_sim)
    try:
        with pytest.raises(ProviderCallError) as excinfo:
            await client.chat([ChatMessage(role="user", content="hi")])
    finally:
        await client.aclose()
    assert excinfo.value.category == "auth_permanent"


# --- OpenAI Responses (codex) dialect ---------------------------------------------


async def test_codex_chat_roundtrip_with_journal(provider_sim: ProviderSimulator) -> None:
    provider_sim.queue(
        "gpt-codex-sim",
        Behavior(reply="codex answer", reasoning="summary thought", prompt_tokens=21),
    )
    client = _codex_client(provider_sim)
    try:
        response = await client.chat([ChatMessage(role="user", content="hello codex")])
    finally:
        await client.aclose()
    assert response.content == "codex answer"
    assert response.reasoning == "summary thought"
    assert response.usage.prompt_tokens == 21
    assert response.finish_reason == "stop"

    (entry,) = provider_sim.calls(dialect="openai-responses")
    # The codex client is stream-only and authenticates with the subscription
    # bearer token; both must be visible on the wire.
    assert entry["stream"] is True
    assert entry["auth"]["authorization"] == "Bearer sim-codex-token"


async def test_codex_tool_calls_aggregate_from_fragments(
    provider_sim: ProviderSimulator,
) -> None:
    provider_sim.queue(
        "gpt-codex-sim",
        Behavior(
            tool_calls=[SimToolCall(id="call_cx", name="apply_patch", arguments='{"diff": "x"}')]
        ),
    )
    client = _codex_client(provider_sim)
    try:
        response = await client.chat(
            [ChatMessage(role="user", content="patch it")],
            tools=[{"name": "apply_patch", "parameters": {"type": "object"}}],
        )
    finally:
        await client.aclose()
    assert response.tool_calls == [
        ToolCall(id="call_cx", name="apply_patch", arguments='{"diff": "x"}')
    ]


async def test_codex_stream_chat_yields_deltas(provider_sim: ProviderSimulator) -> None:
    provider_sim.queue("gpt-codex-sim", Behavior(reply="alpha beta"))
    client = _codex_client(provider_sim)
    text: list[str] = []
    finish = None
    try:
        async for chunk in client.stream_chat([ChatMessage(role="user", content="go")]):
            text.append(chunk.delta)
            if chunk.finish_reason is not None:
                finish = chunk.finish_reason
    finally:
        await client.aclose()
    assert "".join(text) == "alpha beta"
    assert finish == "stop"


async def test_codex_auth_error_is_permanent(provider_sim: ProviderSimulator) -> None:
    provider_sim.queue("gpt-codex-sim", Behavior(error=SimError.invalid_api_key()))
    client = _codex_client(provider_sim)
    try:
        with pytest.raises(ProviderCallError) as excinfo:
            await client.chat([ChatMessage(role="user", content="hi")])
    finally:
        await client.aclose()
    assert excinfo.value.category == "auth_permanent"
    assert len(provider_sim.calls(dialect="openai-responses")) == 1
