"""Wire-client matrix: every core behavior x every provider client family.

One parametrized suite over ``PROVIDER_PROFILES`` (OpenAI, Anthropic, Google,
Codex) replaces per-provider hand-written tests: the REAL SDK-backed clients
round-trip replies, reasoning, usage, streaming reassembly, tool calls (both
modes) and the whole provider error taxonomy against the simulator. Tests
branch only on *declared* profile capabilities, so adding a provider is one
profile entry + one wire module — the matrix picks it up everywhere.
"""

from __future__ import annotations

import pytest
from fusionkit_core.clients import ProviderCallError, build_client
from fusionkit_core.types import ChatMessage, ToolCall
from fusionkit_testkit import Behavior, ProviderSimulator, SimError, SimToolCall, sim_endpoint
from fusionkit_testkit.matrix import ProviderProfile, provider_params

TOOLS = [{"name": "run_tool", "parameters": {"type": "object"}}]


def _reassemble_single_call(fragments: list[ToolCall]) -> ToolCall:
    """Reassemble one streamed tool call the way every dialect's fragments
    compose: id/name arrive on (at least) the opening fragment, arguments
    concatenate in order."""
    call_id = next((fragment.id for fragment in fragments if fragment.id), "")
    name = next((fragment.name for fragment in fragments if fragment.name), "")
    arguments = "".join(fragment.arguments for fragment in fragments)
    return ToolCall(id=call_id, name=name, arguments=arguments)


# --- chat roundtrip (reply + reasoning + usage + auth + dialect) --------------------


@pytest.mark.parametrize("profile", provider_params())
async def test_chat_roundtrip(profile: ProviderProfile, provider_sim: ProviderSimulator) -> None:
    endpoint = profile.endpoint(provider_sim, suffix="chat")
    provider_sim.queue(
        profile.model("chat"),
        Behavior(
            reply="the matrix answer",
            reasoning="matrix thinking",
            prompt_tokens=17,
            completion_tokens=5,
        ),
    )
    client = build_client(endpoint)
    try:
        response = await client.chat([ChatMessage(role="user", content="answer me")])
    finally:
        await client.aclose()

    assert response.content == "the matrix answer"
    assert response.reasoning == "matrix thinking"
    assert response.finish_reason == profile.text_finish_reason
    assert response.usage.prompt_tokens == 17
    assert response.usage.completion_tokens == 5

    (entry,) = provider_sim.calls(model=profile.model("chat"), dialect=profile.dialect)
    assert entry["dialect"] == profile.dialect
    assert entry["auth"][profile.auth_field] == profile.expected_auth(endpoint)


# --- streaming reassembly (text + terminal usage) --------------------------------------


@pytest.mark.parametrize("profile", provider_params())
async def test_stream_reassembles_text_and_usage(
    profile: ProviderProfile, provider_sim: ProviderSimulator
) -> None:
    endpoint = profile.endpoint(provider_sim, suffix="stream")
    provider_sim.queue(
        profile.model("stream"),
        Behavior(reply="alpha beta gamma delta", prompt_tokens=9),
    )
    client = build_client(endpoint)
    text: list[str] = []
    usage_prompt_tokens = None
    try:
        async for chunk in client.stream_chat([ChatMessage(role="user", content="go")]):
            text.append(chunk.delta)
            if chunk.usage is not None and chunk.usage.prompt_tokens is not None:
                usage_prompt_tokens = chunk.usage.prompt_tokens
    finally:
        await client.aclose()
    assert "".join(text) == "alpha beta gamma delta"
    assert usage_prompt_tokens == 9
    stream_calls = provider_sim.calls(model=profile.model("stream"), dialect=profile.dialect)
    assert stream_calls[0]["stream"] is True


# --- tool calls, both modes --------------------------------------------------------------


@pytest.mark.parametrize("profile", provider_params())
async def test_tool_call_roundtrip(
    profile: ProviderProfile, provider_sim: ProviderSimulator
) -> None:
    endpoint = profile.endpoint(provider_sim, suffix="tool")
    provider_sim.queue(
        profile.model("tool"),
        Behavior(
            tool_calls=[SimToolCall(id="call_mx", name="run_tool", arguments='{"arg": "value"}')]
        ),
    )
    client = build_client(endpoint)
    try:
        response = await client.chat([ChatMessage(role="user", content="use it")], tools=TOOLS)
    finally:
        await client.aclose()
    assert response.finish_reason == profile.tool_finish_reason
    (call,) = response.tool_calls
    assert call.id == "call_mx"
    assert call.name == "run_tool"
    assert call.arguments == '{"arg": "value"}'


@pytest.mark.parametrize("profile", provider_params())
async def test_streamed_tool_call_reassembles(
    profile: ProviderProfile, provider_sim: ProviderSimulator
) -> None:
    endpoint = profile.endpoint(provider_sim, suffix="stool")
    provider_sim.queue(
        profile.model("stool"),
        Behavior(
            tool_calls=[SimToolCall(id="call_sx", name="run_tool", arguments='{"arg": "stream"}')]
        ),
    )
    client = build_client(endpoint)
    fragments: list[ToolCall] = []
    try:
        async for chunk in client.stream_chat(
            [ChatMessage(role="user", content="stream it")], tools=TOOLS
        ):
            if chunk.tool_call_delta is not None:
                fragments.append(chunk.tool_call_delta)
    finally:
        await client.aclose()
    call = _reassemble_single_call(fragments)
    assert call.id == "call_sx"
    assert call.name == "run_tool"
    assert call.arguments == '{"arg": "stream"}'


# --- the provider error taxonomy ----------------------------------------------------------

ERROR_CASES = [
    pytest.param(SimError.invalid_api_key, "auth_permanent", id="auth"),
    pytest.param(SimError.quota_exhausted, None, id="quota"),  # profile.quota_category
    pytest.param(SimError.context_overflow, "context_overflow", id="overflow"),
]


@pytest.mark.parametrize("profile", provider_params())
@pytest.mark.parametrize(("make_error", "expected_category"), ERROR_CASES)
async def test_error_classification(
    profile: ProviderProfile,
    make_error,
    expected_category: str | None,
    provider_sim: ProviderSimulator,
) -> None:
    expected = expected_category or profile.quota_category
    endpoint = profile.endpoint(provider_sim, suffix="err")
    # Queue enough copies for the worst case: 429-family errors get up to 3
    # SDK-internal attempts on SDKs that retry internally, and up to 3
    # FusionKit-level attempts where the profile classifies them transient.
    provider_sim.queue(profile.model("err"), *[Behavior(error=make_error()) for _ in range(9)])
    client = build_client(endpoint)
    try:
        with pytest.raises(ProviderCallError) as excinfo:
            await client.chat([ChatMessage(role="user", content="fail")])
    finally:
        await client.aclose()
    assert excinfo.value.category == expected

    attempts = provider_sim.calls(model=profile.model("err"), dialect=profile.dialect)
    if expected in ("auth_permanent", "context_overflow"):
        # Hard failures are never retried by any layer.
        assert len(attempts) == 1, provider_sim.describe_journal()
    else:
        # Retryable-family failures stay within the combined SDK x FusionKit
        # retry budget (3 x 3).
        assert 1 <= len(attempts) <= 9, provider_sim.describe_journal()


@pytest.mark.parametrize("profile", provider_params())
async def test_transient_rate_limit_recovers(
    profile: ProviderProfile, provider_sim: ProviderSimulator
) -> None:
    endpoint = profile.endpoint(provider_sim, suffix="rl")
    provider_sim.queue(
        profile.model("rl"),
        Behavior(error=SimError.rate_limited(retry_after=0.0)),
        Behavior(reply="recovered"),
    )
    client = build_client(endpoint)
    try:
        response = await client.chat([ChatMessage(role="user", content="throttle me")])
    finally:
        await client.aclose()
    assert response.content == "recovered"
    rl_calls = provider_sim.calls(model=profile.model("rl"), dialect=profile.dialect)
    statuses = [entry["status"] for entry in rl_calls]
    assert statuses == [429, 200], provider_sim.describe_journal()


# --- OpenRouter's post-response cost accounting (provider_cost wire) ----------------


async def test_openrouter_provider_cost_lookup_round_trips(
    provider_sim: ProviderSimulator,
) -> None:
    endpoint = sim_endpoint(provider_sim, id="or-cost", model="or-model", provider="openrouter")
    provider_sim.queue(
        "or-model",
        Behavior(reply="costed answer", provider_cost_usd=0.00321, prompt_tokens=50),
    )
    client = build_client(endpoint)
    try:
        response = await client.chat([ChatMessage(role="user", content="how much?")])
    finally:
        await client.aclose()
    assert response.content == "costed answer"
    # The client fetched /v1/generation and attached the provider-reported cost.
    assert response.provider_cost is not None
    assert response.provider_cost.lookup_status == "ok"
    assert response.provider_cost.cost_usd == 0.00321
    assert response.provider_cost.tokens_prompt == 50
    lookups = provider_sim.calls(dialect="openrouter-generation")
    assert len(lookups) == 1
    assert lookups[0]["auth"]["authorization"] == "Bearer sk-test-or-cost"


async def test_openrouter_streaming_terminal_chunk_carries_provider_cost(
    provider_sim: ProviderSimulator,
) -> None:
    endpoint = sim_endpoint(provider_sim, id="or-scost", model="or-smodel", provider="openrouter")
    provider_sim.queue(
        "or-smodel", Behavior(reply="streamed costed answer", provider_cost_usd=0.007)
    )
    client = build_client(endpoint)
    terminal_cost = None
    try:
        async for chunk in client.stream_chat([ChatMessage(role="user", content="stream cost")]):
            if chunk.provider_cost is not None:
                terminal_cost = chunk.provider_cost
    finally:
        await client.aclose()
    assert terminal_cost is not None
    assert terminal_cost.cost_usd == 0.007
    assert terminal_cost.lookup_status == "ok"


@pytest.mark.parametrize("profile", provider_params())
async def test_truncated_stream_surfaces_an_error(
    profile: ProviderProfile, provider_sim: ProviderSimulator
) -> None:
    endpoint = profile.endpoint(provider_sim, suffix="cut")
    provider_sim.queue(
        profile.model("cut"),
        Behavior(reply="one two three four five six seven eight", broken_stream="truncate"),
    )
    client = build_client(endpoint)
    try:
        with pytest.raises(Exception):  # noqa: B017 - any transport error is acceptable
            async for _chunk in client.stream_chat([ChatMessage(role="user", content="die")]):
                pass
    finally:
        await client.aclose()
