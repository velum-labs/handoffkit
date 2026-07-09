"""End-to-end engine tests: the REAL fusionkit server + REAL provider clients
against the provider simulator.

Unlike the fusionkit-server unit tests (which inject ``FakeModelClient``
behind the client boundary), these run ``create_app(config)`` with the real
``build_clients`` factory, so every layer between the HTTP surface and the
provider wire executes for real: request normalization, the fusion kernel,
panel fanout, judge + synthesizer calls, the OpenAI/Anthropic SDK clients,
retry/error classification, and SSE emission. The simulator's journal then
proves what actually crossed the provider wire.
"""

from __future__ import annotations

import json
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from fusionkit_core.config import FusionConfig
from fusionkit_server import create_app
from fusionkit_testkit import (
    Behavior,
    ProviderSimulator,
    SimError,
    SimToolCall,
    panel_config,
    parse_sse,
    sim_endpoint,
    sse_text,
)

JUDGE_ANALYSIS = json.dumps(
    {
        "consensus": ["both candidates agree on the approach"],
        "contradictions": [],
        "unique_insights": ["candidate b adds error handling"],
        "coverage_gaps": [],
        "likely_errors": [],
        "recommended_final_structure": ["answer directly"],
    }
)


@pytest.fixture
def sim() -> Iterator[ProviderSimulator]:
    with ProviderSimulator() as simulator:
        yield simulator


def _mixed_panel_config(sim: ProviderSimulator) -> FusionConfig:
    """A decorrelated two-vendor panel (one OpenAI-wire, one Anthropic-wire
    member) with dedicated judge and synthesizer endpoints — the realistic
    production shape."""
    return panel_config(
        sim,
        members=[
            sim_endpoint(sim, id="member-openai", model="gpt-panel-a", provider="openai"),
            sim_endpoint(sim, id="member-anthropic", model="claude-panel-b", provider="anthropic"),
        ],
        judge=sim_endpoint(sim, id="judge", model="gpt-judge", provider="openai"),
        synthesizer=sim_endpoint(sim, id="synth", model="gpt-synth", provider="openai"),
    )


@pytest.fixture
def client(sim: ProviderSimulator) -> Iterator[TestClient]:
    # Context-managed on purpose: an unentered TestClient runs every request
    # on a fresh event loop, which strands the app's pooled provider
    # connections (the real SDK clients keep an httpx pool) and causes
    # spurious cross-request failures.
    with TestClient(create_app(_mixed_panel_config(sim))) as test_client:
        yield test_client


def test_panel_fanout_judge_and_synthesis_over_the_real_wire(
    sim: ProviderSimulator, client: TestClient
) -> None:
    sim.queue("gpt-panel-a", Behavior(reply="candidate A: use a dict"))
    sim.queue("claude-panel-b", Behavior(reply="candidate B: use a dict with error handling"))
    sim.queue("gpt-judge", Behavior(reply=JUDGE_ANALYSIS))
    sim.queue("gpt-synth", Behavior(reply="fused: use a dict, with error handling"))

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "fusionkit/panel",
            "messages": [{"role": "user", "content": "how should I store the index?"}],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["choices"][0]["message"]["content"] == "fused: use a dict, with error handling"
    # Usage is the ledgered sum of real wire calls, not a fabricated block.
    assert body["usage"]["total_tokens"] > 0

    # The journal proves the full production call graph hit the provider wire:
    # both members (each on its own dialect), then judge, then synthesizer.
    journal = sim.journal()
    dialect_by_model = {entry["model"]: entry["dialect"] for entry in journal}
    assert dialect_by_model["gpt-panel-a"] == "openai-chat"
    assert dialect_by_model["claude-panel-b"] == "anthropic-messages"
    ordered_models = [entry["model"] for entry in journal]
    assert ordered_models.index("gpt-judge") < ordered_models.index("gpt-synth")
    # The judge really saw both candidates.
    judge_text = json.dumps(sim.journal_for("gpt-judge")[0]["request"]["messages"])
    assert "use a dict" in judge_text
    assert "error handling" in judge_text


def test_fused_streaming_streams_real_synthesizer_tokens(
    sim: ProviderSimulator, client: TestClient
) -> None:
    sim.queue("gpt-panel-a", Behavior(reply="candidate A"))
    sim.queue("claude-panel-b", Behavior(reply="candidate B"))
    sim.queue("gpt-judge", Behavior(reply=JUDGE_ANALYSIS))
    sim.queue("gpt-synth", Behavior(reply="streamed fused answer over several tokens"))

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "fusionkit/panel",
            "stream": True,
            "messages": [{"role": "user", "content": "stream it"}],
        },
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert sse_text(parse_sse(response.text)) == "streamed fused answer over several tokens"
    # Streaming really reached the provider wire as a streaming request.
    assert sim.journal_for("gpt-synth")[0]["stream"] is True


def test_passthrough_routes_to_one_endpoint_without_fusion(
    sim: ProviderSimulator, client: TestClient
) -> None:
    sim.queue("claude-panel-b", Behavior(reply="passthrough answer"))

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "member-anthropic",
            "messages": [{"role": "user", "content": "direct question"}],
        },
    )

    assert response.status_code == 200
    assert response.json()["choices"][0]["message"]["content"] == "passthrough answer"
    # No fusion machinery ran: exactly one wire call, on the Anthropic dialect.
    journal = sim.journal()
    assert len(journal) == 1
    assert journal[0]["dialect"] == "anthropic-messages"


def test_passthrough_tool_loop_round_trip(sim: ProviderSimulator, client: TestClient) -> None:
    tools = [
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "read a file",
                "parameters": {"type": "object", "properties": {"path": {"type": "string"}}},
            },
        }
    ]

    # Turn 1: the model asks for a tool.
    sim.queue(
        "gpt-panel-a",
        Behavior(
            tool_calls=[SimToolCall(id="call_r1", name="read_file", arguments='{"path": "x"}')]
        ),
    )
    first = client.post(
        "/v1/chat/completions",
        json={
            "model": "member-openai",
            "messages": [{"role": "user", "content": "what is in x?"}],
            "tools": tools,
        },
    )
    assert first.status_code == 200
    message = first.json()["choices"][0]["message"]
    assert first.json()["choices"][0]["finish_reason"] == "tool_calls"
    (tool_call,) = message["tool_calls"]
    assert tool_call["function"]["name"] == "read_file"

    # Turn 2: the caller executes the tool and posts the result back.
    sim.queue("gpt-panel-a", Behavior(reply="x contains 42"))
    second = client.post(
        "/v1/chat/completions",
        json={
            "model": "member-openai",
            "messages": [
                {"role": "user", "content": "what is in x?"},
                {"role": "assistant", "content": None, "tool_calls": [tool_call]},
                {"role": "tool", "tool_call_id": tool_call["id"], "content": "42"},
            ],
            "tools": tools,
        },
    )
    assert second.status_code == 200
    assert second.json()["choices"][0]["message"]["content"] == "x contains 42"

    # The tool result really crossed the wire on the second request.
    turn2_request = sim.journal_for("gpt-panel-a")[1]["request"]
    roles = [m["role"] for m in turn2_request["messages"]]
    assert "tool" in roles


def test_panel_degrades_gracefully_when_one_member_fails_permanently(
    sim: ProviderSimulator, client: TestClient
) -> None:
    sim.queue("gpt-panel-a", Behavior(error=SimError.invalid_api_key()))
    sim.queue("claude-panel-b", Behavior(reply="surviving candidate"))
    sim.queue("gpt-judge", Behavior(reply=JUDGE_ANALYSIS))
    sim.queue("gpt-synth", Behavior(reply="fused from the survivor"))

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "fusionkit/panel",
            "messages": [{"role": "user", "content": "degrade gracefully"}],
        },
    )

    assert response.status_code == 200
    assert response.json()["choices"][0]["message"]["content"] == "fused from the survivor"
    # The failed member's 401 is visible on the wire and was not retried.
    assert [entry["status"] for entry in sim.journal_for("gpt-panel-a")] == [401]


def test_passthrough_surfaces_provider_errors_as_openai_error_body(
    sim: ProviderSimulator, client: TestClient
) -> None:
    sim.queue("gpt-panel-a", Behavior(error=SimError.invalid_api_key()))
    response = client.post(
        "/v1/chat/completions",
        json={"model": "member-openai", "messages": [{"role": "user", "content": "hi"}]},
    )
    assert response.status_code == 401
    assert "error" in response.json()


def test_trajectories_fuse_step_over_the_real_wire(
    sim: ProviderSimulator, client: TestClient
) -> None:
    """The Node gateway's one seam into Python: POST candidate trajectories to
    ``/v1/fusion/trajectories:fuse`` and get a judged + synthesized step back."""
    sim.queue("gpt-judge", Behavior(reply=JUDGE_ANALYSIS))
    sim.queue("gpt-synth", Behavior(reply="synthesized from two candidates"))

    response = client.post(
        "/v1/fusion/trajectories:fuse",
        json={
            "model": "fusion-panel",
            "messages": [{"role": "user", "content": "pick the best fix"}],
            "trajectories": [
                {
                    "trajectory_id": "t_a",
                    "model_id": "member-openai",
                    "status": "succeeded",
                    "final_output": "fix by clamping the index",
                },
                {
                    "trajectory_id": "t_b",
                    "model_id": "member-anthropic",
                    "status": "succeeded",
                    "final_output": "fix by validating the input",
                },
            ],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["choices"][0]["message"]["content"] == "synthesized from two candidates"
    decision = body["fusion"]["trajectory"]["synthesis"]["decision"]
    assert decision in ("synthesize", "select_trajectory")
    # Both candidates reached the judge over the real wire.
    judge_text = json.dumps(sim.journal_for("gpt-judge")[0]["request"]["messages"])
    assert "clamping the index" in judge_text
    assert "validating the input" in judge_text


def test_trajectories_fuse_streams_synthesizer_tokens(
    sim: ProviderSimulator, client: TestClient
) -> None:
    sim.queue("gpt-judge", Behavior(reply=JUDGE_ANALYSIS))
    sim.queue("gpt-synth", Behavior(reply="streamed synthesis result"))

    response = client.post(
        "/v1/fusion/trajectories:fuse",
        json={
            "model": "fusion-panel",
            "stream": True,
            "messages": [{"role": "user", "content": "fuse and stream"}],
            "trajectories": [
                {
                    "trajectory_id": "t_a",
                    "model_id": "member-openai",
                    "status": "succeeded",
                    "final_output": "candidate answer",
                }
            ],
        },
    )

    assert response.status_code == 200
    assert sse_text(parse_sse(response.text)) == "streamed synthesis result"


def test_transient_provider_failures_are_retried_through_the_full_stack(
    sim: ProviderSimulator, client: TestClient
) -> None:
    # Three consecutive 500s exhaust the openai SDK's own internal retry
    # budget (max_retries=2 -> 3 wire attempts), so surviving them proves
    # FusionKit's `_call_with_retries` layer re-invoked the call — not just
    # the SDK's built-in retry. The journal shows all four wire attempts.
    sim.queue(
        "gpt-panel-a",
        *[Behavior(error=SimError.server_error()) for _ in range(3)],
        Behavior(reply="recovered after retry"),
    )
    response = client.post(
        "/v1/chat/completions",
        json={"model": "member-openai", "messages": [{"role": "user", "content": "hi"}]},
    )
    assert response.status_code == 200
    assert response.json()["choices"][0]["message"]["content"] == "recovered after retry"
    assert [entry["status"] for entry in sim.journal_for("gpt-panel-a")] == [500, 500, 500, 200]
