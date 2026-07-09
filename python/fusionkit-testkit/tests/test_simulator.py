"""Simulator self-tests: the wire must be faithful enough for the REAL
FusionKit provider clients (openai / anthropic SDKs underneath) to parse.

These are the foundation the e2e suites stand on: if the real
``OpenAICompatibleClient`` / ``AnthropicModelClient`` round-trip text, tool
calls, reasoning, streaming and errors against the simulator, then everything
above them (engine, server, gateway) is being tested against a realistic
provider — not a shortcut fake injected behind the wire.
"""

from __future__ import annotations

import pytest
from fusionkit_core.clients import ProviderCallError, build_client
from fusionkit_core.config import ModelEndpoint, SamplingConfig
from fusionkit_core.types import ChatMessage, ToolCall
from fusionkit_testkit import Behavior, ProviderSimulator, SimError, SimToolCall


@pytest.fixture
def sim():
    with ProviderSimulator() as simulator:
        yield simulator


def _openai_endpoint(sim: ProviderSimulator, model: str = "gpt-sim") -> ModelEndpoint:
    return ModelEndpoint(
        id="openai-ep",
        model=model,
        base_url=sim.url,
        provider="openai",
        api_key="sk-test",
        timeout_s=10.0,
    )


def _anthropic_endpoint(sim: ProviderSimulator, model: str = "claude-sim") -> ModelEndpoint:
    return ModelEndpoint(
        id="anthropic-ep",
        model=model,
        base_url=sim.url,
        provider="anthropic",
        api_key="sk-ant-test",
        timeout_s=10.0,
    )


# --- OpenAI dialect ----------------------------------------------------------


async def test_openai_chat_roundtrip_with_journal(sim: ProviderSimulator) -> None:
    sim.queue("gpt-sim", Behavior(reply="the answer is 42", reasoning="thinking hard"))
    client = build_client(_openai_endpoint(sim))
    try:
        response = await client.chat([ChatMessage(role="user", content="what is the answer?")])
    finally:
        await client.aclose()

    assert response.content == "the answer is 42"
    assert response.reasoning == "thinking hard"
    assert response.finish_reason == "stop"
    assert response.usage.prompt_tokens == 7
    assert response.usage.total_tokens is not None

    # The journal is the observation plane: assert what actually hit the wire.
    (entry,) = sim.journal()
    assert entry["dialect"] == "openai-chat"
    assert entry["model"] == "gpt-sim"
    assert entry["source"] == "queued"
    assert entry["auth"]["authorization"] == "Bearer sk-test"
    # The openai provider's request shape (registry providerRequestShapes)
    # must reach the wire: max_completion_tokens, no sampling knobs.
    assert "max_completion_tokens" in entry["request"]
    assert "temperature" not in entry["request"]


async def test_openai_tool_calls_roundtrip(sim: ProviderSimulator) -> None:
    sim.queue(
        "gpt-sim",
        Behavior(
            reply="checking the weather",
            tool_calls=[
                SimToolCall(id="call_1", name="get_weather", arguments='{"city": "Berlin"}')
            ],
        ),
    )
    client = build_client(_openai_endpoint(sim))
    try:
        response = await client.chat(
            [ChatMessage(role="user", content="weather?")],
            tools=[{"name": "get_weather", "parameters": {"type": "object"}}],
        )
    finally:
        await client.aclose()
    assert response.finish_reason == "tool_calls"
    assert response.tool_calls == [
        ToolCall(id="call_1", name="get_weather", arguments='{"city": "Berlin"}')
    ]
    (entry,) = sim.journal()
    assert entry["request"]["tools"][0]["function"]["name"] == "get_weather"


async def test_openai_streaming_reassembles_text_tools_and_usage(sim: ProviderSimulator) -> None:
    sim.queue(
        "gpt-sim",
        Behavior(
            reply="alpha beta gamma",
            reasoning="brief thought",
            tool_calls=[SimToolCall(id="call_9", name="run", arguments='{"cmd": "ls -la"}')],
        ),
    )
    client = build_client(_openai_endpoint(sim))
    text: list[str] = []
    reasoning: list[str] = []
    fragments: list[ToolCall] = []
    finish: str | None = None
    usage_seen = False
    try:
        async for chunk in client.stream_chat([ChatMessage(role="user", content="go")]):
            text.append(chunk.delta)
            if chunk.model_reasoning_delta:
                reasoning.append(chunk.model_reasoning_delta)
            if chunk.tool_call_delta is not None:
                fragments.append(chunk.tool_call_delta)
            if chunk.finish_reason is not None:
                finish = chunk.finish_reason
            if chunk.usage is not None:
                usage_seen = True
    finally:
        await client.aclose()

    assert "".join(text) == "alpha beta gamma"
    assert "".join(reasoning) == "brief thought"
    assert finish == "tool_calls"
    # The simulator split the arguments across fragments; reassembly is the
    # caller's job — verify the fragments carry the full JSON in order.
    assert fragments[0].id == "call_9"
    assert fragments[0].name == "run"
    assert "".join(fragment.arguments for fragment in fragments) == '{"cmd": "ls -la"}'
    # The openai provider requests stream_options.include_usage, so the
    # terminal usage frame must arrive.
    assert usage_seen


async def test_openai_rate_limit_is_retried_and_visible_in_journal(
    sim: ProviderSimulator,
) -> None:
    sim.queue(
        "gpt-sim",
        Behavior(error=SimError.rate_limited(retry_after=0.0)),
        Behavior(reply="recovered"),
    )
    client = build_client(_openai_endpoint(sim))
    try:
        response = await client.chat([ChatMessage(role="user", content="hi")])
    finally:
        await client.aclose()
    assert response.content == "recovered"
    entries = sim.journal_for("gpt-sim")
    assert [entry["status"] for entry in entries] == [429, 200]


async def test_openai_auth_error_is_classified_permanent_not_retried(
    sim: ProviderSimulator,
) -> None:
    sim.queue("gpt-sim", Behavior(error=SimError.invalid_api_key()))
    client = build_client(_openai_endpoint(sim))
    try:
        with pytest.raises(ProviderCallError) as excinfo:
            await client.chat([ChatMessage(role="user", content="hi")])
    finally:
        await client.aclose()
    assert excinfo.value.category == "auth_permanent"
    assert excinfo.value.status_code == 401
    # Permanent errors must never be retried: exactly one wire request.
    assert len(sim.journal_for("gpt-sim")) == 1


async def test_openai_quota_and_context_overflow_classification(sim: ProviderSimulator) -> None:
    # Quota errors ride on HTTP 429, which the openai SDK itself retries
    # (max_retries=2 -> up to 3 wire requests) before FusionKit's
    # classification sees the failure — queue one per attempt.
    sim.queue("gpt-sim", *[Behavior(error=SimError.quota_exhausted()) for _ in range(3)])
    client = build_client(_openai_endpoint(sim))
    try:
        with pytest.raises(ProviderCallError) as quota:
            await client.chat([ChatMessage(role="user", content="hi")])
        sim.queue("gpt-sim", Behavior(error=SimError.context_overflow()))
        with pytest.raises(ProviderCallError) as overflow:
            await client.chat([ChatMessage(role="user", content="hi")])
    finally:
        await client.aclose()
    assert quota.value.category == "quota_exhausted"
    assert overflow.value.category == "context_overflow"


async def test_openai_truncated_stream_surfaces_an_error(sim: ProviderSimulator) -> None:
    sim.queue("gpt-sim", Behavior(reply="one two three four five six", broken_stream="truncate"))
    client = build_client(_openai_endpoint(sim))
    try:
        with pytest.raises(Exception):  # noqa: B017 - any transport error is acceptable
            async for _chunk in client.stream_chat([ChatMessage(role="user", content="go")]):
                pass
    finally:
        await client.aclose()


async def test_default_behavior_echoes_when_nothing_is_queued(sim: ProviderSimulator) -> None:
    client = build_client(_openai_endpoint(sim))
    try:
        response = await client.chat([ChatMessage(role="user", content="ping")])
    finally:
        await client.aclose()
    assert "ping" in response.content
    assert sim.journal()[0]["source"] == "default"


# --- Anthropic dialect --------------------------------------------------------


async def test_anthropic_chat_roundtrip(sim: ProviderSimulator) -> None:
    sim.queue(
        "claude-sim",
        Behavior(reply="bonjour", reasoning="reflecting", prompt_tokens=11, completion_tokens=3),
    )
    client = build_client(_anthropic_endpoint(sim))
    try:
        response = await client.chat([ChatMessage(role="user", content="salut")])
    finally:
        await client.aclose()
    assert response.content == "bonjour"
    assert response.reasoning == "reflecting"
    assert response.finish_reason == "end_turn"
    assert response.usage.prompt_tokens == 11
    assert response.usage.completion_tokens == 3
    (entry,) = sim.journal()
    assert entry["dialect"] == "anthropic-messages"
    assert entry["auth"]["x_api_key"] == "sk-ant-test"


async def test_anthropic_tool_use_roundtrip(sim: ProviderSimulator) -> None:
    sim.queue(
        "claude-sim",
        Behavior(tool_calls=[SimToolCall(id="toolu_1", name="edit", arguments='{"path": "a.py"}')]),
    )
    client = build_client(_anthropic_endpoint(sim))
    try:
        response = await client.chat(
            [ChatMessage(role="user", content="edit it")],
            tools=[{"name": "edit", "parameters": {"type": "object"}}],
        )
    finally:
        await client.aclose()
    assert response.finish_reason == "tool_use"
    assert response.tool_calls[0].name == "edit"
    assert response.tool_calls[0].arguments == '{"path": "a.py"}'


async def test_anthropic_streaming_text_tools_and_usage(sim: ProviderSimulator) -> None:
    sim.queue(
        "claude-sim",
        Behavior(
            reply="stream me home",
            tool_calls=[SimToolCall(id="toolu_2", name="run", arguments='{"cmd": "pytest -q"}')],
            prompt_tokens=13,
        ),
    )
    client = build_client(_anthropic_endpoint(sim))
    text: list[str] = []
    fragments: list[ToolCall] = []
    terminal_usage = None
    try:
        async for chunk in client.stream_chat(
            [ChatMessage(role="user", content="go")], sampling=SamplingConfig(max_tokens=64)
        ):
            text.append(chunk.delta)
            if chunk.tool_call_delta is not None:
                fragments.append(chunk.tool_call_delta)
            if chunk.usage is not None:
                terminal_usage = chunk.usage
    finally:
        await client.aclose()
    assert "".join(text) == "stream me home"
    assert fragments[0].id == "toolu_2"
    assert fragments[0].name == "run"
    assert "".join(fragment.arguments for fragment in fragments) == '{"cmd": "pytest -q"}'
    # Anthropic splits usage across message_start/message_delta; the client
    # must stitch prompt+completion tokens back together on the terminal chunk.
    assert terminal_usage is not None
    assert terminal_usage.prompt_tokens == 13


async def test_anthropic_overloaded_is_transient(sim: ProviderSimulator) -> None:
    sim.queue(
        "claude-sim",
        Behavior(error=SimError.overloaded()),
        Behavior(reply="back up"),
    )
    client = build_client(_anthropic_endpoint(sim))
    try:
        response = await client.chat([ChatMessage(role="user", content="hi")])
    finally:
        await client.aclose()
    assert response.content == "back up"
    statuses = [entry["status"] for entry in sim.journal_for("claude-sim")]
    assert statuses == [529, 200]


# --- control plane over HTTP (what the Node suite uses) ------------------------


async def test_http_control_plane_scripts_and_observes(sim: ProviderSimulator) -> None:
    import httpx

    async with httpx.AsyncClient(base_url=sim.url, timeout=5.0) as http:
        queued = await http.post(
            "/__sim/behaviors",
            json={"model": "gpt-sim", "behaviors": [{"reply": "scripted over http"}]},
        )
        assert queued.status_code == 200

        client = build_client(_openai_endpoint(sim))
        try:
            response = await client.chat([ChatMessage(role="user", content="hi")])
        finally:
            await client.aclose()
        assert response.content == "scripted over http"

        journal = (await http.get("/__sim/journal")).json()["entries"]
        assert journal[0]["model"] == "gpt-sim"
        assert journal[0]["source"] == "queued"

        reset = await http.post("/__sim/reset", json={})
        assert reset.status_code == 200
        assert (await http.get("/__sim/journal")).json()["entries"] == []
