"""Config builders that point real FusionKit endpoints at the simulator.

Deliberately thin: they return the same :class:`ModelEndpoint` /
:class:`FusionConfig` objects production uses, so a test composes its stack
explicitly (simulator -> endpoints -> config -> app or engine process) instead
of hiding the topology behind a fixture. Over-abstracting here would recreate
the problem this testkit exists to fix.
"""

from __future__ import annotations

from fusionkit_core.config import FusionConfig, FusionMode, ModelEndpoint, ProviderKind

from fusionkit_testkit.server import ProviderSimulator


def sim_endpoint(
    sim: ProviderSimulator,
    *,
    id: str,
    model: str,
    provider: ProviderKind = "openai",
    timeout_s: float = 15.0,
) -> ModelEndpoint:
    """A real ``ModelEndpoint`` whose provider client will call the simulator.

    ``provider`` selects the real wire client (``openai`` -> OpenAI SDK against
    ``/v1/chat/completions``, ``anthropic`` -> Anthropic SDK against
    ``/v1/messages``, ``openai-compatible`` -> the generic OpenAI-wire client).
    """
    return ModelEndpoint(
        id=id,
        model=model,
        base_url=sim.url,
        provider=provider,
        api_key=f"sk-test-{id}",
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
