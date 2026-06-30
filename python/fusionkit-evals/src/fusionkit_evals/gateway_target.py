"""Describe the fusion gateway as a target an external benchmark runner can hit.

The whole public-benchmark strategy rests on one fact: the fusion gateway already
speaks the dialects external coding harnesses expect (OpenAI Chat, Anthropic
Messages, OpenAI Responses) and exposes itself as a single model. So an official
benchmark runner (Aider, an SWE-bench Pro agent scaffold, Terminal-Bench, ...)
can be pointed at the gateway exactly as if it were one strong model, and the
fused output is compared to the published per-model leaderboard.

This module produces the connection details a runner needs - base URL, the model
alias that triggers fusion, the right path for each dialect, and the environment
variables most OpenAI/Anthropic-compatible runners read - without starting or
owning the server itself (``fusionkit serve`` / the CLI fusion gateway do that).
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

GatewayDialect = Literal["openai-chat", "anthropic-messages", "openai-responses"]

# Reserved fusion model aliases understood by the server's /v1/chat/completions:
# anything else that names a configured endpoint is a per-model passthrough.
FUSION_MODEL_ALIASES: tuple[str, ...] = (
    "fusionkit/router",
    "fusionkit/panel",
    "fusionkit/self",
    "fusionkit/single",
)

_DIALECT_PATHS: dict[GatewayDialect, str] = {
    "openai-chat": "/v1/chat/completions",
    "anthropic-messages": "/v1/messages",
    "openai-responses": "/v1/responses",
}


class GatewayTarget(BaseModel):
    """Connection details for pointing an external runner at the gateway."""

    base_url: str = "http://127.0.0.1:8080"
    model: str = "fusionkit/panel"
    dialect: GatewayDialect = "openai-chat"
    api_key_env: str = "FUSIONKIT_GATEWAY_API_KEY"

    @property
    def normalized_base_url(self) -> str:
        return self.base_url.rstrip("/")

    @property
    def path(self) -> str:
        return _DIALECT_PATHS[self.dialect]

    @property
    def endpoint_url(self) -> str:
        return f"{self.normalized_base_url}{self.path}"

    @property
    def is_fusion_alias(self) -> bool:
        return self.model in FUSION_MODEL_ALIASES

    def runner_env(self) -> dict[str, str]:
        """Environment variables most compatible runners read to find the gateway.

        Returns the base-URL overrides for each dialect family plus a placeholder
        for the API key env var (the runner supplies the actual secret); callers
        should merge this over ``os.environ``. The gateway itself does not require
        a key, but most runners refuse to start without one set.
        """

        env: dict[str, str] = {}
        if self.dialect in ("openai-chat", "openai-responses"):
            env["OPENAI_BASE_URL"] = self.normalized_base_url
            env["OPENAI_API_BASE"] = self.normalized_base_url
        if self.dialect == "anthropic-messages":
            env["ANTHROPIC_BASE_URL"] = self.normalized_base_url
        return env


def default_dialect_for_runner(runner: str) -> GatewayDialect:
    """Best-guess dialect for a known external runner name."""

    normalized = runner.strip().lower()
    if "claude" in normalized or "anthropic" in normalized:
        return "anthropic-messages"
    if "codex" in normalized or "responses" in normalized:
        return "openai-responses"
    return "openai-chat"


__all__ = [
    "FUSION_MODEL_ALIASES",
    "GatewayDialect",
    "GatewayTarget",
    "default_dialect_for_runner",
]
