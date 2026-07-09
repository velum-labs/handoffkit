"""Engine passthrough matrix: the engine's per-endpoint door x every provider
family x {JSON, SSE, tool loop, provider error} — one parametrized suite
through the real app + real clients, replacing per-provider passthrough
tests. The tool-loop case is the deepest: OpenAI-shaped tool calls and tool
results must round-trip through each provider's own wire dialect (nested
function calls, tool_use/tool_result blocks, functionCall/functionResponse
parts, function_call/function_call_output items).
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
    SimError,
    SimToolCall,
    panel_config,
    parse_sse,
    sse_done,
    sse_text,
)
from fusionkit_testkit.matrix import PROVIDER_PROFILES, ProviderProfile, provider_params

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "read a file",
            "parameters": {"type": "object", "properties": {"path": {"type": "string"}}},
        },
    }
]


@pytest.fixture
def client(provider_sim: ProviderSimulator) -> Iterator[TestClient]:
    """One engine app fronting an endpoint per provider family."""
    members = [
        profile.endpoint(provider_sim, suffix="door") for profile in PROVIDER_PROFILES
    ]
    with TestClient(create_app(panel_config(provider_sim, members=members))) as test_client:
        yield test_client


def _endpoint_id(profile: ProviderProfile) -> str:
    return f"ep-{profile.provider}-door"


@pytest.mark.parametrize("profile", provider_params())
def test_passthrough_json(
    profile: ProviderProfile, provider_sim: ProviderSimulator, client: TestClient
) -> None:
    provider_sim.queue(profile.model("door"), "matrix passthrough answer")
    response = client.post(
        "/v1/chat/completions",
        json={
            "model": _endpoint_id(profile),
            "messages": [{"role": "user", "content": "direct"}],
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["choices"][0]["message"]["content"] == "matrix passthrough answer"
    (entry,) = provider_sim.calls(model=profile.model("door"), dialect=profile.dialect)
    assert entry["dialect"] == profile.dialect


@pytest.mark.parametrize("profile", provider_params())
def test_passthrough_streaming(
    profile: ProviderProfile, provider_sim: ProviderSimulator, client: TestClient
) -> None:
    provider_sim.queue(profile.model("door"), "streamed through the matrix door")
    response = client.post(
        "/v1/chat/completions",
        json={
            "model": _endpoint_id(profile),
            "stream": True,
            "messages": [{"role": "user", "content": "stream"}],
        },
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert sse_text(parse_sse(response.text)) == "streamed through the matrix door"
    assert sse_done(response.text)


@pytest.mark.parametrize("profile", provider_params())
def test_passthrough_tool_loop_round_trips_the_provider_dialect(
    profile: ProviderProfile, provider_sim: ProviderSimulator, client: TestClient
) -> None:
    # Turn 1: the model asks for a tool (each dialect's own tool-call wire).
    provider_sim.queue(
        profile.model("door"),
        Behavior(
            tool_calls=[SimToolCall(id="call_mx", name="read_file", arguments='{"path": "x"}')]
        ),
    )
    first = client.post(
        "/v1/chat/completions",
        json={
            "model": _endpoint_id(profile),
            "messages": [{"role": "user", "content": "read x"}],
            "tools": TOOLS,
        },
    )
    assert first.status_code == 200, first.text
    (tool_call,) = first.json()["choices"][0]["message"]["tool_calls"]
    assert tool_call["function"]["name"] == "read_file"
    assert json.loads(tool_call["function"]["arguments"]) == {"path": "x"}

    # Turn 2: the tool result goes back and must translate into the provider's
    # own result vocabulary on the wire.
    provider_sim.queue(profile.model("door"), "x contains 42")
    second = client.post(
        "/v1/chat/completions",
        json={
            "model": _endpoint_id(profile),
            "messages": [
                {"role": "user", "content": "read x"},
                {"role": "assistant", "content": None, "tool_calls": [tool_call]},
                {
                    "role": "tool",
                    "tool_call_id": tool_call["id"],
                    "name": "read_file",
                    "content": "42",
                },
            ],
            "tools": TOOLS,
        },
    )
    assert second.status_code == 200, second.text
    assert second.json()["choices"][0]["message"]["content"] == "x contains 42"
    door_calls = provider_sim.calls(model=profile.model("door"), dialect=profile.dialect)
    turn2 = door_calls[1]["request"]
    wire = json.dumps(turn2)
    expected_marker = {
        "openai-chat": '"role": "tool"',
        "anthropic-messages": '"type": "tool_result"',
        "google-generate": '"functionResponse"',
        "openai-responses": '"type": "function_call_output"',
    }[profile.dialect]
    assert expected_marker in wire, (
        f"tool result must ride the {profile.dialect} wire: {wire[:400]}"
    )


@pytest.mark.parametrize("profile", provider_params())
def test_passthrough_surfaces_provider_auth_errors(
    profile: ProviderProfile, provider_sim: ProviderSimulator, client: TestClient
) -> None:
    provider_sim.queue(profile.model("door"), Behavior(error=SimError.invalid_api_key()))
    response = client.post(
        "/v1/chat/completions",
        json={"model": _endpoint_id(profile), "messages": [{"role": "user", "content": "hi"}]},
    )
    assert response.status_code == 401, response.text
    assert response.json()["error"]["error_category"] == "auth_permanent"
    # Permanent failures are never retried on any wire.
    assert len(provider_sim.calls(model=profile.model("door"), dialect=profile.dialect)) == 1
