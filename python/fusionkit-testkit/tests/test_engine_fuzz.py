"""Hostile-input fuzzing of the Python engine's OpenAI door.

Expectation-free invariants over malformed and randomly generated request
bodies, complementing the scripted suites (which only explore well-formed
request space):

- a structurally malformed body is a 4xx with a parseable JSON body and ZERO
  provider fanout (garbage must never spend panel money);
- no response leaks Python internals (tracebacks, exception reprs);
- the engine keeps serving after every hostile request.
"""

from __future__ import annotations

import random as random_module
import re
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from fusionkit_server import create_app
from fusionkit_testkit import ProviderSimulator, panel_config, sim_endpoint

LEAKED_INTERNALS = re.compile(
    r"Traceback \(most recent call last\)|"
    r"\bTypeError\b|\bAttributeError\b|\bKeyError\b|"
    r'File "/'
)


@pytest.fixture
def client(provider_sim: ProviderSimulator) -> Iterator[TestClient]:
    config = panel_config(
        provider_sim,
        members=[sim_endpoint(provider_sim, id="m", model="fuzz-m", provider="openai")],
        judge=sim_endpoint(provider_sim, id="j", model="fuzz-j", provider="openai"),
    )
    with TestClient(create_app(config), raise_server_exceptions=False) as test_client:
        yield test_client


REJECTED: list[tuple[str, dict[str, Any]]] = [
    ("empty body", {}),
    ("null messages", {"model": "fusionkit/panel", "messages": None}),
    ("string messages", {"model": "fusionkit/panel", "messages": "hi"}),
    ("role-less message", {"model": "fusionkit/panel", "messages": [{"content": "x"}]}),
    (
        "numeric content",
        {"model": "fusionkit/panel", "messages": [{"role": "user", "content": 42}]},
    ),
    (
        "array model",
        {"model": ["fusionkit/panel"], "messages": [{"role": "user", "content": "x"}]},
    ),
    (
        "unknown role",
        {"model": "fusionkit/panel", "messages": [{"role": "attacker", "content": "x"}]},
    ),
    (
        "negative max_tokens",
        {
            "model": "m",
            "messages": [{"role": "user", "content": "x"}],
            "max_tokens": -5,
        },
    ),
    (
        "out-of-range top_p",
        {
            "model": "m",
            "messages": [{"role": "user", "content": "x"}],
            "top_p": 1.5,
        },
    ),
    (
        "malformed tool arguments",
        {
            "model": "m",
            "messages": [
                {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "call_bad",
                            "type": "function",
                            "function": {"name": "read", "arguments": '{"broken"'},
                        }
                    ],
                }
            ],
        },
    ),
]


@pytest.mark.parametrize(("name", "body"), REJECTED, ids=[case[0] for case in REJECTED])
def test_malformed_bodies_reject_without_fanout(
    name: str, body: dict[str, Any], provider_sim: ProviderSimulator, client: TestClient
) -> None:
    before = len(provider_sim.journal())
    response = client.post("/v1/chat/completions", json=body)
    assert response.status_code == 422, f"{name}: {response.text[:300]}"
    assert response.json() is not None, name
    assert not LEAKED_INTERNALS.search(response.text), f"{name}: {response.text[:300]}"
    assert len(provider_sim.journal()) == before, (
        f"{name}: a rejected body must never reach the provider wire\n"
        + provider_sim.describe_journal()
    )
    assert client.get("/v1/models").status_code == 200


def test_invalid_json_is_a_4xx(client: TestClient) -> None:
    response = client.post(
        "/v1/chat/completions",
        content=b'{"model":',
        headers={"content-type": "application/json"},
    )
    assert response.status_code == 422
    assert response.json() is not None


def test_unknown_model_rejects_without_fanout(
    provider_sim: ProviderSimulator, client: TestClient
) -> None:
    before = len(provider_sim.journal())
    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "no-such-model",
            "messages": [{"role": "user", "content": "do not silently fuse"}],
        },
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "unknown_model"
    assert len(provider_sim.journal()) == before


def test_tolerated_oddities_still_complete(
    provider_sim: ProviderSimulator, client: TestClient
) -> None:
    tolerated: list[tuple[str, dict[str, Any]]] = [
        (
            "null-byte + astral unicode",
            {
                "model": "m",
                "messages": [{"role": "user", "content": "a\x00b \U0001f600 \u4e16\u754c"}],
            },
        ),
        (
            "null content",
            {"model": "m", "messages": [{"role": "user", "content": None}]},
        ),
        (
            "large content (256 KiB)",
            {"model": "m", "messages": [{"role": "user", "content": "A" * (256 * 1024)}]},
        ),
    ]
    for name, body in tolerated:
        response = client.post("/v1/chat/completions", json=body)
        assert response.status_code == 200, f"{name}: {response.text[:300]}"
        assert not LEAKED_INTERNALS.search(response.text), name


_MODELS: list[Any] = ["fusionkit/panel", "m", "no-such-model", "", 42, None, ["a"]]
_ROLES: list[Any] = ["user", "assistant", "system", "tool", "attacker", "", 7, None]
_CONTENTS: list[Any] = [
    "hello",
    "",
    "\x00\ufffd",
    13,
    None,
    ["not a part"],
    [{"type": "text", "text": "x"}],
    {"deep": True},
]
_EXTRAS: list[dict[str, Any]] = [
    {},
    {"stream": True},
    {"stream": "maybe"},
    {"max_tokens": -1},
    {"max_tokens": "many"},
    {"tools": []},
    {"tools": "hammer"},
    {"temperature": "hot"},
    {"fusion": {"mode": "bogus"}},
    {"fusion": "off"},
]


def _random_body(rng: random_module.Random) -> dict[str, Any]:
    messages: list[Any] = []
    for _ in range(rng.randrange(4)):
        if rng.random() < 0.15:
            messages.append(rng.choice(["not-an-object", 42, None]))
        else:
            messages.append({"role": rng.choice(_ROLES), "content": rng.choice(_CONTENTS)})
    body: dict[str, Any] = {"model": rng.choice(_MODELS), "messages": messages}
    if rng.random() < 0.1:
        body["messages"] = rng.choice([None, "hi", 42])
    body.update(rng.choice(_EXTRAS))
    return body


def test_seeded_random_bodies_never_hang_or_leak(
    provider_sim: ProviderSimulator, client: TestClient
) -> None:
    seed = 0xF0511
    rng = random_module.Random(seed)
    for round_index in range(40):
        body = _random_body(rng)
        response = client.post("/v1/chat/completions", json=body)
        detail = f"seed={seed} round={round_index} body={body!r} -> {response.status_code}"
        assert response.status_code in (200, 400, 422, 502), (
            f"{detail} {response.text[:300]}"
        )
        assert not LEAKED_INTERNALS.search(response.text), f"{detail} {response.text[:400]}"
    assert client.get("/v1/models").status_code == 200
