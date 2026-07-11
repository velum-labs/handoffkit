"""Adversarial wire conditions through the real engine + real clients.

These are the tests designed to fail: broken provider streams mid-flight,
parallel tool-call fragments packed into single chunks, garbage SSE frames —
each asserting the engine's documented degradation contract (an OpenAI-style
error event before ``[DONE]``, never a hang or a silent truncation).
"""

from __future__ import annotations

import json
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from fusionkit_server import create_app
from fusionkit_testkit import (
    Behavior,
    ProviderSimulator,
    SimToolCall,
    panel_config,
    parse_sse,
    sim_endpoint,
    sse_done,
)


@pytest.fixture
def client(provider_sim: ProviderSimulator) -> Iterator[TestClient]:
    config = panel_config(
        provider_sim,
        members=[
            sim_endpoint(provider_sim, id="member-openai", model="gpt-adv", provider="openai"),
            sim_endpoint(
                provider_sim, id="member-anthropic", model="claude-adv", provider="anthropic"
            ),
        ],
        judge=sim_endpoint(provider_sim, id="judge", model="gpt-adv-judge", provider="openai"),
    )
    with TestClient(create_app(config)) as test_client:
        yield test_client


# --- broken provider streams ----------------------------------------------------


def test_truncated_provider_stream_surfaces_error_event_and_terminates(
    provider_sim: ProviderSimulator, client: TestClient
) -> None:
    provider_sim.queue(
        "gpt-adv",
        Behavior(reply="one two three four five six seven eight", broken_stream="truncate"),
    )
    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "member-openai",
            "stream": True,
            "messages": [{"role": "user", "content": "stream then die"}],
        },
    )
    assert response.status_code == 200
    frames = parse_sse(response.text)
    # The documented contract: a mid-stream provider failure becomes an
    # OpenAI-style error event, then the stream closes with [DONE]. A hang or
    # a silently truncated "success" here is a product bug.
    assert sse_done(response.text), "broken upstream must still terminate with [DONE]"
    error_frames = [frame for frame in frames if "error" in frame]
    assert error_frames, f"expected an SSE error event, got: {response.text[:800]}"


def test_garbage_provider_frame_surfaces_error_event_and_terminates(
    provider_sim: ProviderSimulator, client: TestClient
) -> None:
    provider_sim.queue(
        "gpt-adv",
        Behavior(reply="alpha beta gamma delta epsilon zeta", broken_stream="garbage"),
    )
    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "member-openai",
            "stream": True,
            "messages": [{"role": "user", "content": "stream garbage"}],
        },
    )
    assert response.status_code == 200
    assert sse_done(response.text)
    error_frames = [frame for frame in parse_sse(response.text) if "error" in frame]
    assert error_frames, f"expected an SSE error event, got: {response.text[:800]}"


def test_truncated_anthropic_stream_degrades_with_error_event(
    provider_sim: ProviderSimulator, client: TestClient
) -> None:
    provider_sim.queue(
        "claude-adv",
        Behavior(reply="a long streamed anthropic answer that dies", broken_stream="truncate"),
    )
    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "member-anthropic",
            "stream": True,
            "messages": [{"role": "user", "content": "anthropic stream then die"}],
        },
    )
    assert response.status_code == 200
    assert sse_done(response.text)
    assert any("error" in frame for frame in parse_sse(response.text))


# --- parallel tool calls (multi-slot chunks) --------------------------------------


def test_parallel_tool_calls_survive_multi_slot_stream_chunks(
    provider_sim: ProviderSimulator, client: TestClient
) -> None:
    """The real OpenAI wire may pack fragments for several tool-call slots into
    ONE chunk (parallel calls). The simulator emits the slot openings that way;
    both calls must survive reassembly through the whole engine."""
    provider_sim.queue(
        "gpt-adv",
        Behavior(
            tool_calls=[
                SimToolCall(id="call_a", name="read_file", arguments='{"path": "a.py"}'),
                SimToolCall(id="call_b", name="run_tests", arguments='{"target": "unit"}'),
            ]
        ),
    )
    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "member-openai",
            "stream": True,
            "messages": [{"role": "user", "content": "do two things at once"}],
            "tools": [
                {"type": "function", "function": {"name": "read_file", "parameters": {}}},
                {"type": "function", "function": {"name": "run_tests", "parameters": {}}},
            ],
        },
    )
    assert response.status_code == 200
    frames = parse_sse(response.text)
    # Reassemble the tool calls exactly like an OpenAI client would.
    calls: dict[int, dict[str, str]] = {}
    for frame in frames:
        for fragment in (frame.get("choices") or [{}])[0].get("delta", {}).get("tool_calls", []):
            slot = calls.setdefault(fragment["index"], {"id": "", "name": "", "arguments": ""})
            if fragment.get("id"):
                slot["id"] = fragment["id"]
            function = fragment.get("function", {})
            if function.get("name"):
                slot["name"] = function["name"]
            slot["arguments"] += function.get("arguments", "")
    assert len(calls) == 2, f"both parallel calls must survive: {calls}"
    assert calls[0]["id"] == "call_a"
    assert json.loads(calls[0]["arguments"]) == {"path": "a.py"}
    assert calls[1]["id"] == "call_b"
    assert calls[1]["name"] == "run_tests"
    assert json.loads(calls[1]["arguments"]) == {"target": "unit"}


def test_parallel_tool_calls_survive_non_streaming_roundtrip(
    provider_sim: ProviderSimulator, client: TestClient
) -> None:
    provider_sim.queue(
        "gpt-adv",
        Behavior(
            tool_calls=[
                SimToolCall(id="call_a", name="read_file", arguments='{"path": "a.py"}'),
                SimToolCall(id="call_b", name="run_tests", arguments='{"target": "unit"}'),
            ]
        ),
    )
    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "member-openai",
            "messages": [{"role": "user", "content": "do two things"}],
            "tools": [
                {"type": "function", "function": {"name": "read_file", "parameters": {}}},
                {"type": "function", "function": {"name": "run_tests", "parameters": {}}},
            ],
        },
    )
    assert response.status_code == 200
    tool_calls = response.json()["choices"][0]["message"]["tool_calls"]
    assert [call["id"] for call in tool_calls] == ["call_a", "call_b"]


# --- latency injection: slow member must not fail the request ----------------------


def test_slow_provider_is_waited_for_not_dropped(
    provider_sim: ProviderSimulator, client: TestClient
) -> None:
    provider_sim.queue("gpt-adv", Behavior(reply="slow but correct", delay_s=1.5))
    response = client.post(
        "/v1/chat/completions",
        json={"model": "member-openai", "messages": [{"role": "user", "content": "take time"}]},
    )
    assert response.status_code == 200
    assert response.json()["choices"][0]["message"]["content"] == "slow but correct"
