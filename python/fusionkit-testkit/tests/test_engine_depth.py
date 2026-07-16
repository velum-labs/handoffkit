"""Engine depth suite: the behaviors that make fusion a product, not a demo.

Multi-turn fused tool loops, per-provider wire-shape fidelity, rate-limit
storms vs quota exhaustion, the synthesizer's context-overflow fallback
ladder, per-request prompt-override propagation, exact usage accounting, and
concurrency isolation — all through the real app + real provider clients,
asserted against the simulator's wire journal.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import pytest
from fastapi.testclient import TestClient
from fusionkit_server import create_app
from fusionkit_testkit import (
    Behavior,
    ProviderSimulator,
    SimError,
    SimToolCall,
    judge_analysis,
    panel_config,
    parse_sse,
    sim_endpoint,
)

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
    config = panel_config(
        provider_sim,
        members=[
            sim_endpoint(provider_sim, id="member-a", model="gpt-deep-a", provider="openai"),
            sim_endpoint(provider_sim, id="member-b", model="claude-deep-b", provider="anthropic"),
        ],
        judge=sim_endpoint(provider_sim, id="judge", model="gpt-deep-judge", provider="openai"),
        synthesizer=sim_endpoint(
            provider_sim, id="synth", model="gpt-deep-synth", provider="openai"
        ),
    )
    with TestClient(create_app(config)) as test_client:
        yield test_client


# --- multi-turn fused agent loop (tools through the FUSED path) --------------------


def test_fused_multi_turn_tool_loop(provider_sim: ProviderSimulator, client: TestClient) -> None:
    """The core agent loop: turn 1 the fused step asks for a tool; the caller
    executes it and posts the result; turn 2 re-enters panel + fuse and
    produces the final answer grounded in the tool output."""
    # Turn 1: candidates answer, the synthesizer commits a tool call.
    provider_sim.queue("gpt-deep-a", "we should read the config file")
    provider_sim.queue("claude-deep-b", "check config.yaml first")
    provider_sim.queue("gpt-deep-judge", Behavior(reply=judge_analysis()))
    provider_sim.queue(
        "gpt-deep-synth",
        Behavior(
            tool_calls=[
                SimToolCall(
                    id="call_cfg", name="read_file", arguments='{"path": "config.yaml"}'
                )
            ]
        ),
    )
    turn1 = client.post(
        "/v1/chat/completions",
        json={
            "model": "fusionkit/panel",
            "messages": [{"role": "user", "content": "why is the port wrong?"}],
            "tools": TOOLS,
        },
    )
    assert turn1.status_code == 200, turn1.text
    choice = turn1.json()["choices"][0]
    assert choice["finish_reason"] == "tool_calls"
    (tool_call,) = choice["message"]["tool_calls"]
    assert tool_call["function"]["name"] == "read_file"
    assert json.loads(tool_call["function"]["arguments"]) == {"path": "config.yaml"}
    # The synthesizer was offered the caller's tools on the wire.
    synth_request = provider_sim.calls(model="gpt-deep-synth")[0]["request"]
    assert any(
        tool.get("function", {}).get("name") == "read_file"
        for tool in synth_request.get("tools", [])
    )

    # Turn 2: the caller executed the tool; the loop closes on a final answer.
    provider_sim.queue("gpt-deep-a", "the port is 8081 in config.yaml")
    provider_sim.queue("claude-deep-b", "config.yaml pins port 8081")
    provider_sim.queue("gpt-deep-judge", Behavior(reply=judge_analysis()))
    provider_sim.queue("gpt-deep-synth", "final: config.yaml sets port 8081, update it")
    turn2 = client.post(
        "/v1/chat/completions",
        json={
            "model": "fusionkit/panel",
            "messages": [
                {"role": "user", "content": "why is the port wrong?"},
                {"role": "assistant", "content": None, "tool_calls": [tool_call]},
                {"role": "tool", "tool_call_id": tool_call["id"], "content": "port: 8081"},
            ],
            "tools": TOOLS,
        },
    )
    assert turn2.status_code == 200, turn2.text
    assert turn2.json()["choices"][0]["message"]["content"] == (
        "final: config.yaml sets port 8081, update it"
    )
    # The tool output really reached the synthesizer's second wire call.
    synth_turn2 = provider_sim.calls(model="gpt-deep-synth")[1]["request"]
    assert "port: 8081" in json.dumps(synth_turn2["messages"])


# --- per-provider wire request-shape fidelity ---------------------------------------


def test_wire_request_shape_matrix(provider_sim: ProviderSimulator) -> None:
    """Sampling and system prompts must land as each provider's wire dialect
    demands (registry providerRequestShapes): OpenAI takes
    ``max_completion_tokens`` and omits sampling knobs; Anthropic takes
    ``max_tokens`` + a ``system`` param; Google folds everything into
    ``generationConfig``/``systemInstruction``; Codex forwards no sampling and
    carries the system text as Responses ``instructions``."""
    config = panel_config(
        provider_sim,
        members=[
            sim_endpoint(provider_sim, id="ep-openai", model="m-openai", provider="openai"),
            sim_endpoint(
                provider_sim, id="ep-anthropic", model="m-anthropic", provider="anthropic"
            ),
            sim_endpoint(provider_sim, id="ep-google", model="m-google", provider="google"),
            sim_endpoint(provider_sim, id="ep-codex", model="m-codex", provider="codex"),
        ],
    )
    with TestClient(create_app(config)) as client:
        for endpoint_id in ("ep-openai", "ep-anthropic", "ep-google", "ep-codex"):
            response = client.post(
                "/v1/chat/completions",
                json={
                    "model": endpoint_id,
                    "messages": [
                        {"role": "system", "content": "you are terse"},
                        {"role": "user", "content": "hi"},
                    ],
                    "temperature": 0.7,
                    "max_tokens": 321,
                },
            )
            assert response.status_code == 200, response.text

    openai_request = provider_sim.calls(model="m-openai")[0]["request"]
    assert openai_request["max_completion_tokens"] == 321
    assert "temperature" not in openai_request
    assert openai_request["messages"][0] == {"role": "system", "content": "you are terse"}

    anthropic_request = provider_sim.calls(model="m-anthropic")[0]["request"]
    assert anthropic_request["max_tokens"] == 321
    assert anthropic_request["system"] == "you are terse"
    assert "temperature" not in anthropic_request

    google_request = provider_sim.calls(model="m-google")[0]["request"]
    assert google_request["generationConfig"]["maxOutputTokens"] == 321
    assert google_request["generationConfig"]["temperature"] == 0.7
    assert google_request["systemInstruction"]["parts"][0]["text"] == "you are terse"

    codex_request = provider_sim.calls(model="m-codex")[0]["request"]
    assert codex_request["instructions"] == "you are terse"
    assert codex_request["store"] is False
    assert "temperature" not in codex_request
    assert "max_output_tokens" not in codex_request


# --- failure taxonomy under storm conditions -----------------------------------------


def test_rate_limit_storm_exhausts_retries_then_fuses_from_survivors(
    provider_sim: ProviderSimulator, client: TestClient
) -> None:
    # Member A is rate-limited for every FusionKit-owned attempt; member B
    # answers. Hidden SDK retries are disabled.
    provider_sim.queue(
        "gpt-deep-a", *[Behavior(error=SimError.rate_limited(retry_after=0.0)) for _ in range(12)]
    )
    provider_sim.queue("claude-deep-b", "the only healthy candidate")
    provider_sim.queue("gpt-deep-judge", Behavior(reply=judge_analysis()))
    provider_sim.queue("gpt-deep-synth", "fused despite the storm")

    response = client.post(
        "/v1/chat/completions",
        json={"model": "fusionkit/panel", "messages": [{"role": "user", "content": "storm"}]},
    )
    assert response.status_code == 200, response.text
    assert response.json()["choices"][0]["message"]["content"] == "fused despite the storm"
    storm = provider_sim.calls(model="gpt-deep-a", status=429)
    assert len(storm) == 3, provider_sim.describe_journal()
    assert provider_sim.calls(model="claude-deep-b")[0]["status"] == 200


def test_quota_exhaustion_is_never_retried_by_fusionkit(
    provider_sim: ProviderSimulator, client: TestClient
) -> None:
    provider_sim.queue(
        "gpt-deep-a", *[Behavior(error=SimError.quota_exhausted()) for _ in range(12)]
    )
    provider_sim.queue("claude-deep-b", "healthy candidate")
    provider_sim.queue("gpt-deep-judge", Behavior(reply=judge_analysis()))
    provider_sim.queue("gpt-deep-synth", "fused without the broke member")

    response = client.post(
        "/v1/chat/completions",
        json={"model": "fusionkit/panel", "messages": [{"role": "user", "content": "quota"}]},
    )
    assert response.status_code == 200
    # quota_exhausted is not retryable at the FusionKit layer: the wire may
    # show the SDK's own internal 429 retries (<= 3 attempts) but never a
    # FusionKit-level re-invocation on top.
    attempts = provider_sim.calls(model="gpt-deep-a")
    assert 1 <= len(attempts) <= 3, provider_sim.describe_journal()


# --- the synthesizer context-overflow fallback ladder ---------------------------------


def test_context_overflow_ladder_falls_back_to_a_candidate_answer(
    provider_sim: ProviderSimulator, client: TestClient
) -> None:
    """Documented ladder: full synthesis overflows -> reduced-evidence retry
    overflows -> the turn still completes with a candidate's own answer
    (never a 4xx/5xx to the caller)."""
    provider_sim.queue("gpt-deep-judge", Behavior(reply=judge_analysis(best_trajectory="t_a")))
    provider_sim.queue(
        "gpt-deep-synth",
        Behavior(error=SimError.context_overflow()),
        Behavior(error=SimError.context_overflow()),
    )
    response = client.post(
        "/v1/fusion/trajectories:fuse",
        json={
            "model": "fusion-panel",
            "messages": [{"role": "user", "content": "fuse these"}],
            "trajectories": [
                {
                    "trajectory_id": "t_a",
                    "model_id": "member-a",
                    "status": "succeeded",
                    "final_output": "candidate A final answer",
                },
                {
                    "trajectory_id": "t_b",
                    "model_id": "member-b",
                    "status": "succeeded",
                    "final_output": "candidate B final answer",
                },
            ],
        },
    )
    assert response.status_code == 200, response.text
    content = response.json()["choices"][0]["message"]["content"]
    assert content in ("candidate A final answer", "candidate B final answer")
    # Both overflow attempts really hit the wire (full then reduced evidence).
    overflows = provider_sim.calls(model="gpt-deep-synth", status=400)
    assert len(overflows) == 2, provider_sim.describe_journal()


# --- per-request prompt overrides reach the wire ---------------------------------------


def test_per_request_prompt_overrides_reach_judge_and_synth_wires(
    provider_sim: ProviderSimulator, client: TestClient
) -> None:
    provider_sim.queue("gpt-deep-judge", Behavior(reply=judge_analysis()))
    provider_sim.queue("gpt-deep-synth", "override-governed answer")
    response = client.post(
        "/v1/fusion/trajectories:fuse",
        json={
            "model": "fusion-panel",
            "messages": [{"role": "user", "content": "use the overrides"}],
            "prompts": {
                "judge_system": "JUDGE-OVERRIDE-MARKER: weigh evidence only",
                "synthesizer_system": "SYNTH-OVERRIDE-MARKER: answer in one line",
            },
            "trajectories": [
                {
                    "trajectory_id": "t_a",
                    "model_id": "member-a",
                    "status": "succeeded",
                    "final_output": "candidate",
                }
            ],
        },
    )
    assert response.status_code == 200, response.text
    judge_calls = provider_sim.calls(model="gpt-deep-judge")
    judge_messages = json.dumps(judge_calls[0]["request"]["messages"])
    assert "JUDGE-OVERRIDE-MARKER" in judge_messages
    synth_calls = provider_sim.calls(model="gpt-deep-synth")
    synth_messages = json.dumps(synth_calls[0]["request"]["messages"])
    assert "SYNTH-OVERRIDE-MARKER" in synth_messages


# --- exact usage accounting through the fused stream -----------------------------------


def test_fused_stream_terminal_usage_is_the_exact_judge_plus_synth_sum(
    provider_sim: ProviderSimulator, client: TestClient
) -> None:
    provider_sim.queue("gpt-deep-a", Behavior(reply="A", prompt_tokens=11, completion_tokens=3))
    provider_sim.queue("claude-deep-b", Behavior(reply="B", prompt_tokens=13, completion_tokens=5))
    provider_sim.queue(
        "gpt-deep-judge",
        Behavior(reply=judge_analysis(), prompt_tokens=100, completion_tokens=20),
    )
    provider_sim.queue(
        "gpt-deep-synth",
        Behavior(reply="fused with exact usage", prompt_tokens=200, completion_tokens=40),
    )
    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "fusionkit/panel",
            "stream": True,
            "messages": [{"role": "user", "content": "account for me"}],
        },
    )
    assert response.status_code == 200
    frames = parse_sse(response.text)
    terminal = next(frame for frame in frames if "usage" in frame)
    # The documented contract: the terminal SSE chunk carries the whole fused
    # turn's usage (panel members + judge + synthesizer) so a streaming client
    # accounts the same spend as the buffered JSON response.
    assert terminal["usage"]["prompt_tokens"] == 11 + 13 + 100 + 200
    assert terminal["usage"]["completion_tokens"] == 3 + 5 + 20 + 40
    assert terminal["usage"]["total_tokens"] == 14 + 18 + 120 + 240


# --- concurrency isolation ---------------------------------------------------------------


def test_concurrent_passthrough_requests_are_isolated(
    provider_sim: ProviderSimulator, client: TestClient
) -> None:
    replies = [f"reply-{index}" for index in range(8)]
    provider_sim.queue("gpt-deep-a", *replies)

    def call(index: int) -> str:
        response = client.post(
            "/v1/chat/completions",
            json={
                "model": "member-a",
                "messages": [{"role": "user", "content": f"request {index}"}],
            },
        )
        assert response.status_code == 200
        return response.json()["choices"][0]["message"]["content"]

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(call, range(8)))

    # Under concurrency the FIFO order across requests is not defined, but
    # every scripted reply must be delivered exactly once and nothing dropped
    # or duplicated — and the journal must show exactly 8 wire calls.
    assert sorted(results) == sorted(replies)
    assert len(provider_sim.calls(model="gpt-deep-a")) == 8


# --- passthrough streaming with tools mid-conversation (dialect depth) -------------------


def test_anthropic_passthrough_streaming_tool_loop(
    provider_sim: ProviderSimulator, client: TestClient
) -> None:
    """A streamed Anthropic tool call (input_json_delta fragments) must
    round-trip through the engine into OpenAI-shaped streaming tool_call
    deltas, and the posted tool result must translate back into Anthropic
    tool_result blocks on the next wire call."""
    provider_sim.queue(
        "claude-deep-b",
        Behavior(
            tool_calls=[SimToolCall(id="toolu_x", name="read_file", arguments='{"path": "y"}')]
        ),
    )
    first = client.post(
        "/v1/chat/completions",
        json={
            "model": "member-b",
            "stream": True,
            "messages": [{"role": "user", "content": "read y"}],
            "tools": TOOLS,
        },
    )
    assert first.status_code == 200
    calls: dict[int | str, dict[str, str]] = {}
    for frame in parse_sse(first.text):
        choices = frame.get("choices") or []
        if not choices:
            continue
        for fragment in choices[0].get("delta", {}).get("tool_calls") or []:
            slot = calls.setdefault(
                fragment.get("index", 0), {"id": "", "name": "", "arguments": ""}
            )
            if fragment.get("id"):
                slot["id"] = fragment["id"]
            function: dict[str, Any] = fragment.get("function", {})
            if function.get("name"):
                slot["name"] = function["name"]
            slot["arguments"] += function.get("arguments", "")
    (reassembled,) = calls.values()
    assert reassembled["id"] == "toolu_x"
    assert reassembled["name"] == "read_file"
    assert json.loads(reassembled["arguments"]) == {"path": "y"}

    provider_sim.queue("claude-deep-b", "y says hello")
    second = client.post(
        "/v1/chat/completions",
        json={
            "model": "member-b",
            "messages": [
                {"role": "user", "content": "read y"},
                {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "toolu_x",
                            "type": "function",
                            "function": {"name": "read_file", "arguments": '{"path": "y"}'},
                        }
                    ],
                },
                {"role": "tool", "tool_call_id": "toolu_x", "content": "hello"},
            ],
            "tools": TOOLS,
        },
    )
    assert second.status_code == 200
    assert second.json()["choices"][0]["message"]["content"] == "y says hello"
    # The tool result crossed the wire as an Anthropic tool_result block.
    turn2_request = provider_sim.calls(model="claude-deep-b")[1]["request"]
    assert "tool_result" in json.dumps(turn2_request["messages"])
