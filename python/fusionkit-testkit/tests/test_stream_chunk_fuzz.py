"""Chunk-boundary fuzzing of provider stream parsing, across every provider
family.

Real providers make no promise about how a stream's bytes align to SSE
frames: a TCP chunk may end mid-``data:`` line or mid-UTF-8-rune. The
simulator's ``chunk_bytes`` behavior re-splits the rendered wire bytes at
fixed offsets (1, 3, and 7 bytes — every one of which lands inside the
multi-byte characters below), and the engine + real provider SDKs must
reassemble the streamed text byte-exactly through the engine's own doors.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from fusionkit_server import create_app
from fusionkit_testkit import (
    Behavior,
    ProviderSimulator,
    judge_analysis,
    panel_config,
    parse_sse,
    sim_endpoint,
    sse_done,
    sse_text,
)
from fusionkit_testkit.matrix import PROVIDER_PROFILES, ProviderProfile, provider_params

# Multi-byte UTF-8 on purpose: é (2 bytes), 世界 (3 bytes each), 😀 (4 bytes).
UNICODE_REPLY = "héllo 世界 😀 — fin"

CHUNK_SIZES = [1, 3, 7]


@pytest.fixture
def client(provider_sim: ProviderSimulator) -> Iterator[TestClient]:
    members = [
        profile.endpoint(provider_sim, suffix="chunk") for profile in PROVIDER_PROFILES
    ]
    judge = sim_endpoint(provider_sim, id="judge", model="chunk-judge", provider="openai")
    config = panel_config(provider_sim, members=members, judge=judge)
    with TestClient(create_app(config)) as test_client:
        yield test_client


def _endpoint_id(profile: ProviderProfile) -> str:
    return f"ep-{profile.provider}-chunk"


@pytest.mark.parametrize("chunk_bytes", CHUNK_SIZES)
@pytest.mark.parametrize("profile", provider_params())
def test_streamed_text_reassembles_byte_exactly_at_any_chunk_boundary(
    profile: ProviderProfile,
    chunk_bytes: int,
    provider_sim: ProviderSimulator,
    client: TestClient,
) -> None:
    provider_sim.queue(
        profile.model("chunk"), Behavior(reply=UNICODE_REPLY, chunk_bytes=chunk_bytes)
    )
    response = client.post(
        "/v1/chat/completions",
        json={
            "model": _endpoint_id(profile),
            "stream": True,
            "messages": [{"role": "user", "content": "stream unicode"}],
        },
    )
    assert response.status_code == 200, response.text
    assert sse_text(parse_sse(response.text)) == UNICODE_REPLY, (
        f"{profile.provider} corrupted the stream at chunk_bytes={chunk_bytes}:\n"
        f"{response.text[:800]}"
    )
    assert sse_done(response.text)


def test_fused_turn_survives_pathological_member_chunking(
    provider_sim: ProviderSimulator, client: TestClient
) -> None:
    """A fused streaming turn whose member streams arrive one byte at a time."""
    for profile in PROVIDER_PROFILES:
        provider_sim.queue(
            profile.model("chunk"),
            Behavior(reply=f"{UNICODE_REPLY} from {profile.provider}", chunk_bytes=1),
        )
    provider_sim.queue("chunk-judge", Behavior(reply=judge_analysis()))
    provider_sim.queue("chunk-judge", Behavior(reply=f"fused: {UNICODE_REPLY}", chunk_bytes=3))
    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "fusionkit/panel",
            "stream": True,
            "messages": [{"role": "user", "content": "fuse over byte-split streams"}],
        },
    )
    assert response.status_code == 200, response.text
    assert sse_text(parse_sse(response.text)) == f"fused: {UNICODE_REPLY}", response.text[:800]
    assert sse_done(response.text)
    # Every member's byte-split stream reached the wire and was consumed.
    for profile in PROVIDER_PROFILES:
        assert provider_sim.calls(model=profile.model("chunk")), profile.provider
