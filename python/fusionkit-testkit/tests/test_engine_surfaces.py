"""Engine surface matrix: every HTTP door and fusion mode of the Python
engine, driven through the real app + real provider clients against the
simulator — including a four-provider panel covering every client family
FusionKit ships (OpenAI, Anthropic, Google, Codex).

Also the showcase for the testkit DX: the ``provider_sim`` fixture (zero
wiring), ``script_fused_turn`` (one call scripts a whole fused turn), plain
strings as behaviors, and journal queries via ``sim.calls``.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from fusionkit_core.config import ProviderKind
from fusionkit_server import create_app
from fusionkit_testkit import (
    Behavior,
    ProviderSimulator,
    judge_analysis,
    panel_config,
    script_fused_turn,
    sim_endpoint,
)

# Provider model names, one per client family. Keys are the endpoint ids.
FULL_MATRIX: dict[str, tuple[ProviderKind, str]] = {
    "member-openai": ("openai", "gpt-panel"),
    "member-anthropic": ("anthropic", "claude-panel"),
    "member-google": ("google", "gemini-panel"),
    "member-codex": ("codex", "gpt-codex-panel"),
}


@pytest.fixture
def client(provider_sim: ProviderSimulator) -> Iterator[TestClient]:
    members = [
        sim_endpoint(provider_sim, id=endpoint_id, model=model, provider=provider)
        for endpoint_id, (provider, model) in FULL_MATRIX.items()
    ]
    judge = sim_endpoint(provider_sim, id="judge", model="gpt-judge", provider="openai")
    config = panel_config(provider_sim, members=members, judge=judge)
    with TestClient(create_app(config)) as test_client:
        yield test_client


def _fused_models(provider_sim: ProviderSimulator) -> list[str]:
    return [entry["model"] for entry in provider_sim.calls()]


# --- the full provider matrix, fused ------------------------------------------


def test_panel_fans_out_across_all_four_provider_dialects(
    provider_sim: ProviderSimulator, client: TestClient
) -> None:
    script_fused_turn(
        provider_sim,
        candidates={
            "gpt-panel": "openai candidate",
            "claude-panel": "anthropic candidate",
            "gemini-panel": "google candidate",
            "gpt-codex-panel": "codex candidate",
        },
        judge_model="gpt-judge",
        answer="fused across four provider dialects",
    )
    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "fusionkit/panel",
            "messages": [{"role": "user", "content": "everyone answer"}],
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["choices"][0]["message"]["content"] == "fused across four provider dialects"

    # One wire call per member, each on its own dialect — the journal is proof.
    dialect_by_model = {entry["model"]: entry["dialect"] for entry in provider_sim.calls()}
    assert dialect_by_model["gpt-panel"] == "openai-chat"
    assert dialect_by_model["claude-panel"] == "anthropic-messages"
    assert dialect_by_model["gemini-panel"] == "google-generate"
    assert dialect_by_model["gpt-codex-panel"] == "openai-responses"
    assert len(provider_sim.calls(model="gpt-judge")) == 2, provider_sim.describe_journal()


# --- every fusion mode alias ---------------------------------------------------


def test_single_mode_calls_only_the_default_model(
    provider_sim: ProviderSimulator, client: TestClient
) -> None:
    provider_sim.queue("gpt-panel", "single mode answer")
    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "fusionkit/single",
            "messages": [{"role": "user", "content": "just one model"}],
        },
    )
    assert response.status_code == 200
    assert response.json()["choices"][0]["message"]["content"] == "single mode answer"
    assert _fused_models(provider_sim) == ["gpt-panel"], provider_sim.describe_journal()


def test_self_mode_samples_the_default_model_then_fuses(
    provider_sim: ProviderSimulator, client: TestClient
) -> None:
    provider_sim.queue("gpt-panel", "sample one", "sample two")
    provider_sim.queue("gpt-judge", Behavior(reply=judge_analysis()), "self-consistent answer")
    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "fusionkit/self",
            "messages": [{"role": "user", "content": "sample yourself"}],
            "fusion": {"sample_count": 2},
        },
    )
    assert response.status_code == 200
    assert response.json()["choices"][0]["message"]["content"] == "self-consistent answer"
    # Two samples against the default model, then judge + synthesizer.
    assert len(provider_sim.calls(model="gpt-panel")) == 2, provider_sim.describe_journal()
    assert len(provider_sim.calls(model="gpt-judge")) == 2


def test_heuristic_mode_routes_short_prompts_to_single(
    provider_sim: ProviderSimulator, client: TestClient
) -> None:
    # HeuristicRouter contract: a short prompt with no routing keywords is a
    # `single` route — exactly one wire call, to the default model, no fusion.
    provider_sim.queue("gpt-panel", "routed to single")
    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "fusionkit/heuristic",
            "messages": [{"role": "user", "content": "hello there"}],
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["choices"][0]["message"]["content"] == "routed to single"
    assert _fused_models(provider_sim) == ["gpt-panel"], provider_sim.describe_journal()


def test_heuristic_mode_routes_hard_keywords_to_panel(
    provider_sim: ProviderSimulator, client: TestClient
) -> None:
    # HeuristicRouter contract: a hard keyword ("compare") routes to `panel` —
    # full fanout across every configured member, then judge + synthesizer.
    script_fused_turn(
        provider_sim,
        candidates={
            "gpt-panel": "openai candidate",
            "claude-panel": "anthropic candidate",
            "gemini-panel": "google candidate",
            "gpt-codex-panel": "codex candidate",
        },
        judge_model="gpt-judge",
        answer="fused after heuristic panel route",
    )
    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "fusionkit/heuristic",
            "messages": [{"role": "user", "content": "compare these two designs"}],
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["choices"][0]["message"]["content"] == (
        "fused after heuristic panel route"
    )
    models = set(_fused_models(provider_sim))
    assert {"gpt-panel", "claude-panel", "gemini-panel", "gpt-codex-panel", "gpt-judge"} <= models


# --- discovery + health doors ----------------------------------------------------


def test_models_and_health_doors(client: TestClient) -> None:
    models = {entry["id"] for entry in client.get("/v1/models").json()["data"]}
    aliases = {"fusionkit/panel", "fusionkit/single", "fusionkit/self", "fusionkit/heuristic"}
    assert aliases <= models
    assert set(FULL_MATRIX) <= models
    # Cursor probes the models list relative to its BYOK base URL.
    assert client.get("/v1/cursor/models").json() == client.get("/v1/models").json()
    assert client.get("/health").json()["status"] == "ok"


# --- the Cursor BYOK hybrid door ---------------------------------------------------


def test_cursor_door_translates_the_responses_hybrid_body(
    provider_sim: ProviderSimulator, client: TestClient
) -> None:
    provider_sim.queue("gpt-panel", "cursor hybrid answer")
    response = client.post(
        "/v1/cursor/chat/completions",
        json={
            "model": "member-openai",
            "input": [
                {"type": "message", "role": "developer", "content": "You are a coding agent."},
                {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "fix the bug"}],
                },
            ],
            "stream": False,
            "max_output_tokens": 512,
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["choices"][0]["message"]["content"] == "cursor hybrid answer"
    # The translated request reached the provider wire with the caller's text.
    (entry,) = provider_sim.calls(model="gpt-panel")
    assert "fix the bug" in str(entry["request"]["messages"])


def test_cursor_door_passes_plain_chat_bodies_through(
    provider_sim: ProviderSimulator, client: TestClient
) -> None:
    provider_sim.queue("claude-panel", "cursor ask answer")
    response = client.post(
        "/v1/cursor/chat/completions",
        json={
            "model": "member-anthropic",
            "messages": [{"role": "user", "content": "plain ask"}],
        },
    )
    assert response.status_code == 200
    assert response.json()["choices"][0]["message"]["content"] == "cursor ask answer"


# --- event-sourced native runs (x-fusionkit-record + /v1/fusion/runs/*) ------------


def test_recorded_run_is_inspectable_through_the_runs_api(
    provider_sim: ProviderSimulator, client: TestClient
) -> None:
    script_fused_turn(
        provider_sim,
        candidates={
            "gpt-panel": "candidate 1",
            "claude-panel": "candidate 2",
            "gemini-panel": "candidate 3",
            "gpt-codex-panel": "candidate 4",
        },
        judge_model="gpt-judge",
        answer="recorded fused answer",
    )
    response = client.post(
        "/v1/chat/completions",
        headers={"x-fusionkit-record": "1"},
        json={
            "model": "fusionkit/panel",
            "messages": [{"role": "user", "content": "record this run"}],
        },
    )
    assert response.status_code == 200, response.text
    fusionkit_meta = response.json()["fusionkit"]
    run_id = fusionkit_meta["run_id"]
    assert fusionkit_meta["state"] == "completed"

    summary = client.get(f"/v1/fusion/runs/{run_id}")
    assert summary.status_code == 200
    assert summary.json()["state"] == "completed"

    inspection = client.get(f"/v1/fusion/runs/{run_id}/inspect")
    assert inspection.status_code == 200
    assert inspection.json()["run_id"] == run_id

    events = client.get(f"/v1/fusion/runs/{run_id}/events")
    assert events.status_code == 200
    assert len(events.json()["events"]) > 0

    assert client.get("/v1/fusion/runs/does-not-exist").status_code == 404
