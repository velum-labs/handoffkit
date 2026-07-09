"""The test matrix axes, declared once.

A :class:`ProviderProfile` describes one provider client family — its wire
dialect, how auth appears on the wire, and its *declared* capability quirks —
so suites parametrize over ``PROVIDER_PROFILES`` instead of hand-writing
per-provider tests. Tests branch on declared capabilities, never on provider
name string-compares, which keeps a new provider a one-entry addition here
plus (at most) one new ``wire_*`` module.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest
from fusionkit_core.config import ModelEndpoint, ProviderKind

from fusionkit_testkit.endpoints import sim_endpoint
from fusionkit_testkit.server import ProviderSimulator


@dataclass(frozen=True)
class ProviderProfile:
    """One provider client family as an axis point of the test matrix."""

    #: FusionKit provider kind (selects the real client in ``build_client``).
    provider: ProviderKind
    #: The simulator dialect this family's wire lands on (journal ``dialect``).
    dialect: str
    #: Which journal auth field carries the credential, and its expected value
    #: for an endpoint id ``{id}`` (``{token}`` for subscription providers).
    auth_field: str
    auth_value_template: str
    #: The SDK performs its own internal retries on 429/5xx before FusionKit's
    #: retry layer sees the failure (openai + anthropic SDKs do; google-genai
    #: does not). Governs how many error behaviors a storm must queue.
    sdk_internal_retries: bool
    #: The provider path forwards sampling knobs (temperature) to the wire.
    #: (OpenAI omits sampling per registry shape; Codex forwards none at all.)
    forwards_temperature: bool
    #: Whether the terminal finish/stop reason for a plain text reply.
    text_finish_reason: str
    #: Whether the finish/stop reason for a tool-call reply.
    tool_finish_reason: str
    #: How a quota-exhaustion 429 classifies for this family. WS8.3 requires a
    #: STRUCTURED quota marker on 429s (prose alone must not flip a rate limit
    #: to quota); OpenAI-family and Anthropic wires carry `insufficient_quota`
    #: structurally, while Google delivers quota as 429 RESOURCE_EXHAUSTED —
    #: structurally indistinguishable from throttling — so it stays
    #: `transient` by design (a documented classification gap).
    quota_category: str = "quota_exhausted"

    def model(self, suffix: str) -> str:
        """A per-test provider model name (journal key), unique per profile."""
        return f"{self.provider}-{suffix}"

    def endpoint(
        self, sim: ProviderSimulator, *, suffix: str, timeout_s: float = 15.0
    ) -> ModelEndpoint:
        """A real endpoint for this profile pointed at the simulator."""
        return sim_endpoint(
            sim,
            id=f"ep-{self.provider}-{suffix}",
            model=self.model(suffix),
            provider=self.provider,
            timeout_s=timeout_s,
        )

    def expected_auth(self, endpoint: ModelEndpoint) -> str:
        return self.auth_value_template.format(id=endpoint.id, token="sim-codex-token")


PROVIDER_PROFILES: tuple[ProviderProfile, ...] = (
    ProviderProfile(
        provider="openai",
        dialect="openai-chat",
        auth_field="authorization",
        auth_value_template="Bearer sk-test-{id}",
        sdk_internal_retries=True,
        forwards_temperature=False,
        text_finish_reason="stop",
        tool_finish_reason="tool_calls",
    ),
    ProviderProfile(
        provider="openrouter",
        dialect="openai-chat",
        auth_field="authorization",
        auth_value_template="Bearer sk-test-{id}",
        sdk_internal_retries=True,
        # OpenRouter has no registry request-shape overrides: generic sampling
        # (temperature/top_p/max_tokens) reaches the wire.
        forwards_temperature=True,
        text_finish_reason="stop",
        tool_finish_reason="tool_calls",
    ),
    ProviderProfile(
        provider="anthropic",
        dialect="anthropic-messages",
        auth_field="x_api_key",
        auth_value_template="sk-test-{id}",
        sdk_internal_retries=True,
        forwards_temperature=False,
        text_finish_reason="end_turn",
        tool_finish_reason="tool_use",
    ),
    ProviderProfile(
        provider="google",
        dialect="google-generate",
        auth_field="x_goog_api_key",
        auth_value_template="sk-test-{id}",
        sdk_internal_retries=False,
        forwards_temperature=True,
        text_finish_reason="STOP",
        tool_finish_reason="STOP",
        quota_category="transient",
    ),
    ProviderProfile(
        provider="codex",
        dialect="openai-responses",
        auth_field="authorization",
        auth_value_template="Bearer {token}",
        sdk_internal_retries=True,
        forwards_temperature=False,
        text_finish_reason="stop",
        tool_finish_reason="stop",
    ),
)


def provider_params() -> list[Any]:
    """``pytest.mark.parametrize`` params over every provider profile."""
    return [pytest.param(profile, id=profile.provider) for profile in PROVIDER_PROFILES]
