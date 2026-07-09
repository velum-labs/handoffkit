"""Simulator infrastructure self-tests.

Per-provider wire behavior (roundtrips, streaming reassembly, tool calls, the
error taxonomy) lives in the parametrized matrix (``test_matrix_wire_clients``)
— these tests cover what is genuinely simulator-specific: the control plane,
the journal, default behaviors, and dialect quirks with no cross-provider
analogue.
"""

from __future__ import annotations

import httpx
from fusionkit_core.clients import build_client
from fusionkit_core.types import ChatMessage
from fusionkit_testkit import Behavior, ProviderSimulator, SimError, SimToolCall, sim_endpoint


async def test_default_behavior_echoes_when_nothing_is_queued(
    provider_sim: ProviderSimulator,
) -> None:
    client = build_client(sim_endpoint(provider_sim, id="dflt", model="gpt-dflt"))
    try:
        response = await client.chat([ChatMessage(role="user", content="ping")])
    finally:
        await client.aclose()
    assert "ping" in response.content
    assert provider_sim.journal()[0]["source"] == "default"


async def test_anthropic_overloaded_529_is_transient(provider_sim: ProviderSimulator) -> None:
    # Anthropic's `overloaded_error` rides HTTP 529 — no other provider has an
    # analogue, so it stays a dialect-specific case outside the matrix.
    provider_sim.queue(
        "claude-529",
        Behavior(error=SimError.overloaded()),
        Behavior(reply="back up"),
    )
    client = build_client(
        sim_endpoint(provider_sim, id="a529", model="claude-529", provider="anthropic")
    )
    try:
        response = await client.chat([ChatMessage(role="user", content="hi")])
    finally:
        await client.aclose()
    assert response.content == "back up"
    assert [entry["status"] for entry in provider_sim.calls(model="claude-529")] == [529, 200]


async def test_tool_calls_behavior_without_declared_tools_fails_loudly(
    provider_sim: ProviderSimulator,
) -> None:
    # The realism guardrail: a real model can never call an undeclared tool,
    # so a scripted tool_calls behavior answering a tools-less request must
    # fail the call instead of passing silently (this is what catches an
    # engine that drops the caller's tools).
    provider_sim.queue(
        "gpt-guard",
        Behavior(tool_calls=[SimToolCall(id="c", name="tool", arguments="{}")]),
    )
    client = build_client(sim_endpoint(provider_sim, id="guard", model="gpt-guard"))
    try:
        try:
            await client.chat([ChatMessage(role="user", content="no tools declared")])
            raised = False
        except Exception:  # noqa: BLE001 - any classified provider error is acceptable
            raised = True
    finally:
        await client.aclose()
    assert raised
    (entry,) = provider_sim.calls(model="gpt-guard")
    assert entry["status"] == 400
    assert entry["error_code"] == "sim_tools_not_declared"


async def test_http_control_plane_scripts_and_observes(
    provider_sim: ProviderSimulator,
) -> None:
    async with httpx.AsyncClient(base_url=provider_sim.url, timeout=5.0) as http:
        queued = await http.post(
            "/__sim/behaviors",
            json={"model": "gpt-http", "behaviors": [{"reply": "scripted over http"}]},
        )
        assert queued.status_code == 200

        client = build_client(sim_endpoint(provider_sim, id="http", model="gpt-http"))
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
