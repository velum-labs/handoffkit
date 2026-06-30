from __future__ import annotations

from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, Field, field_validator

FusionMode = Literal["single", "self", "panel", "router"]
ProviderKind = Literal[
    "openai", "anthropic", "google", "openai-compatible", "mlx-lm", "custom", "codex"
]
SubscriptionAuthMode = Literal["api_key", "claude-code", "codex"]


class EndpointAuth(BaseModel):
    """How an endpoint obtains its credential.

    ``api_key`` (the default) keeps the existing behaviour: a literal ``api_key``
    or ``api_key_env`` on the endpoint. The subscription modes read the local CLI
    OAuth store read-only at request time (see ``fusionkit_core.credentials``):
    ``claude-code`` reuses the Claude Code (Pro/Max) login, ``codex`` reuses the
    Codex (ChatGPT) login.
    """

    mode: SubscriptionAuthMode = "api_key"
    credentials_path: str | None = None
    token_env: str | None = None


class EndpointCapabilities(BaseModel):
    structured_output: bool | None = None
    tool_calls: bool | None = None
    streaming: bool | None = None


class CostMetadata(BaseModel):
    input_per_1m_tokens: float | None = Field(default=None, ge=0)
    output_per_1m_tokens: float | None = Field(default=None, ge=0)
    currency: str = "USD"


class RunBudget(BaseModel):
    max_candidates: int | None = Field(default=None, ge=1)
    wall_clock_s: float | None = Field(default=None, ge=0)
    max_cost: float | None = Field(default=None, ge=0)
    max_tool_rounds: int | None = Field(default=None, ge=0)
    max_tool_calls: int | None = Field(default=None, ge=0)


class SamplingConfig(BaseModel):
    temperature: float = 0.2
    top_p: float = 0.95
    max_tokens: int = 1024
    seed: int | None = None


class PromptOverrides(BaseModel):
    """Optional overrides for the built-in fusion system prompts.

    Each field defaults to ``None``, which means "use the built-in constant in
    ``prompts.py``". A non-null value fully replaces that system prompt. This is
    the surface that lets a committed ``.fusionkit/prompts/*.md`` file flow all
    the way into the synthesizer via the router config the CLI generates.
    """

    judge_system: str | None = None
    synthesizer_system: str | None = None


class ModelEndpoint(BaseModel):
    id: str
    model: str
    # Optional for subscription endpoints (claude-code / codex), where the client
    # falls back to the provider's default base URL.
    base_url: str = ""
    api_key: str = "not-needed"
    api_key_env: str | None = None
    provider: ProviderKind = "openai-compatible"
    auth: EndpointAuth = Field(default_factory=EndpointAuth)
    max_context: int | None = None
    estimated_memory_gb: float | None = None
    capabilities: EndpointCapabilities = Field(default_factory=EndpointCapabilities)
    pricing: CostMetadata = Field(default_factory=CostMetadata)
    tags: list[str] = Field(default_factory=list)
    timeout_s: float = 120.0

    @field_validator("base_url")
    @classmethod
    def strip_trailing_slash(cls, value: str) -> str:
        return value.rstrip("/")


class FusionConfig(BaseModel):
    endpoints: list[ModelEndpoint]
    default_model: str
    judge_model: str | None = None
    synthesizer_model: str | None = None
    default_mode: FusionMode = "router"
    sample_count: int = 4
    self_temperatures: list[float] = Field(default_factory=lambda: [0.2, 0.4, 0.6, 0.8])
    panel_models: list[str] = Field(default_factory=list)
    sampling: SamplingConfig = Field(default_factory=SamplingConfig)
    budget: RunBudget = Field(default_factory=RunBudget)
    prompts: PromptOverrides = Field(default_factory=PromptOverrides)
    # When true (default), a coding-harness system prompt arriving in the
    # conversation (e.g. Codex/Claude Code's agent prompt) is used as the primary
    # base for the judge/synthesizer, with the fusion framing layered on top.
    # Set false to fall back to the standalone fusion prompts (e.g. for a weak or
    # heterogeneous synthesizer model that the harness prompt does not fit).
    harness_prompt_passthrough: bool = True
    # When true, text/code fusion (no tools) returns the judge-selected best candidate
    # VERBATIM instead of having the synthesizer rewrite an answer. This best-of-N
    # selection preserves a working candidate's solution (the LLM rewrite can regress
    # passing code) and skips the synth call. Falls back to composition when the judge
    # names no best candidate. No effect on tool-using agent fusion.
    synthesis_select_best: bool = False

    def endpoint_for(self, model_id: str) -> ModelEndpoint:
        for endpoint in self.endpoints:
            if endpoint.id == model_id:
                return endpoint
        raise KeyError(f"Unknown model endpoint: {model_id}")

    @property
    def resolved_judge_model(self) -> str:
        return self.judge_model or self.default_model

    @property
    def resolved_synthesizer_model(self) -> str:
        return self.synthesizer_model or self.resolved_judge_model


def load_config(path: str | Path) -> FusionConfig:
    config_path = Path(path)
    data = yaml.safe_load(config_path.read_text()) or {}
    return FusionConfig.model_validate(data)
