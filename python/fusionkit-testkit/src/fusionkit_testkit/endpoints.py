"""Config builders that point real FusionKit endpoints at the simulator.

Deliberately thin: they return the same :class:`ModelEndpoint` /
:class:`FusionConfig` objects production uses, so a test composes its stack
explicitly (simulator -> endpoints -> config -> app or engine process) instead
of hiding the topology behind a fixture. Over-abstracting here would recreate
the problem this testkit exists to fix.
"""

from __future__ import annotations

import os

from fusionkit_core.config import (
    EndpointAuth,
    FusionConfig,
    FusionMode,
    ModelEndpoint,
    ProviderKind,
)

from fusionkit_testkit.server import ProviderSimulator

# The codex provider authenticates from a subscription token; endpoints built
# here read it from this env var (sim_endpoint seeds a fake value) so no real
# ChatGPT login is ever touched by tests.
CODEX_TEST_TOKEN_ENV = "FUSIONKIT_TESTKIT_CODEX_TOKEN"


def sim_endpoint(
    sim: ProviderSimulator,
    *,
    id: str,
    model: str,
    provider: ProviderKind = "openai",
    timeout_s: float = 15.0,
) -> ModelEndpoint:
    """A real ``ModelEndpoint`` whose provider client will call the simulator.

    ``provider`` selects the real wire client and simulator dialect:
    ``openai`` / ``openrouter`` / ``openai-compatible`` -> OpenAI SDK against
    ``/v1/chat/completions``; ``anthropic`` -> Anthropic SDK against
    ``/v1/messages``; ``google`` -> google-genai against
    ``/v1beta/models/...:generateContent``; ``codex`` -> the stream-only
    OpenAI Responses client against ``/responses`` (with a fake subscription
    token seeded into :data:`CODEX_TEST_TOKEN_ENV`).
    """
    auth = EndpointAuth()
    if provider == "codex":
        os.environ.setdefault(CODEX_TEST_TOKEN_ENV, "sim-codex-token")
        auth = EndpointAuth(mode="codex", token_env=CODEX_TEST_TOKEN_ENV)
    return ModelEndpoint(
        id=id,
        model=model,
        base_url=sim.url,
        provider=provider,
        api_key=f"sk-test-{id}",
        auth=auth,
        timeout_s=timeout_s,
    )


def panel_config(
    sim: ProviderSimulator,
    *,
    members: list[ModelEndpoint],
    judge: ModelEndpoint | None = None,
    synthesizer: ModelEndpoint | None = None,
    default_mode: FusionMode = "panel",
) -> FusionConfig:
    """A production-shaped panel config over simulator-backed endpoints.

    ``judge`` / ``synthesizer`` default to the first member (the same
    fallback the production config resolution applies).
    """
    del sim  # explicit in the signature so call sites read as one composition
    endpoints = list(members)
    if judge is not None and judge not in endpoints:
        endpoints.append(judge)
    if synthesizer is not None and synthesizer not in endpoints:
        endpoints.append(synthesizer)
    first = members[0]
    return FusionConfig(
        endpoints=endpoints,
        default_model=first.id,
        judge_model=(judge or first).id,
        synthesizer_model=(synthesizer or judge or first).id,
        default_mode=default_mode,
        panel_models=[member.id for member in members],
    )
