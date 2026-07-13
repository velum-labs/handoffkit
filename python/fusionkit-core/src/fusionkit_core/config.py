"""FusionKit configuration models and loaders.

Prompt precedence is: per-request overrides > YAML ``prompts`` fields >
``.fusionkit/prompts/{judge,synthesizer}.md`` beside the config file (or the
current working directory when serving from elsewhere) > built-in defaults.
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, Field, field_validator, model_validator

from fusionkit_core.registry import sampling_overrides_for_model

FusionMode = Literal["single", "self", "panel", "heuristic"]
ProviderKind = Literal[
    "openai",
    "anthropic",
    "google",
    "openrouter",
    "cliproxy",
    "openai-compatible",
    "mlx-lm",
    "custom",
    "codex",
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


class ContextPolicy(BaseModel):
    """How judge/synthesizer prompts are budgeted against a model's context window.

    ``default_max_context`` is used when an endpoint declares no ``max_context``.
    ``safety_margin_tokens`` absorbs token-estimation error (the estimator is a
    chars/4 heuristic, which under-counts dense code). ``keep_head_items`` /
    ``keep_tail_items`` control middle-out trajectory packing: the first items
    (the plan) and the last items (the outcome) survive, the middle is elided.
    """

    default_max_context: int = Field(default=64_000, ge=1_024)
    safety_margin_tokens: int = Field(default=2_048, ge=0)
    keep_head_items: int = Field(default=8, ge=0)
    keep_tail_items: int = Field(default=12, ge=0)


class SamplingConfig(BaseModel):
    temperature: float = Field(default=0.2, ge=0, le=2)
    top_p: float = Field(default=0.95, gt=0, le=1)
    max_tokens: int = Field(default=1024, ge=1)
    seed: int | None = None


def merge_sampling(
    override: SamplingConfig | None, fallback: SamplingConfig
) -> SamplingConfig:
    """Overlay request sampling onto config defaults, field by field.

    Only fields the caller explicitly set (differing from generic
    :class:`SamplingConfig` defaults) replace the fallback; everything else
    keeps the operator-configured value.
    """
    if override is None:
        return fallback
    defaults = SamplingConfig()
    updates: dict[str, object] = {}
    for field_name in SamplingConfig.model_fields:
        override_val = getattr(override, field_name)
        if override_val != getattr(defaults, field_name):
            updates[field_name] = override_val
    return fallback.model_copy(update=updates)


def model_sampling_defaults(model: str) -> dict[str, float]:
    """Per-model sampling defaults for panel/passthrough model calls.

    Derived from opencode's production transform table
    (references/opencode/provider/transform.ts, temperature/topP): qwen-family
    models are prone to tool-call repetition loops at generic temperature
    defaults and want temperature 0.55 / top_p 1.0; kimi-k2 wants 0.6 (1.0 for
    the thinking / k2.5+ variants). Returns only the keys that should override
    the generic :class:`SamplingConfig` defaults; callers apply them when
    neither the request nor the operator config pinned a value.
    """
    return sampling_overrides_for_model(model)


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
    id: str = Field(min_length=1)
    model: str = Field(min_length=1)
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
    endpoints: list[ModelEndpoint] = Field(min_length=1)
    default_model: str
    judge_model: str | None = None
    synthesizer_model: str | None = None
    default_mode: FusionMode = "heuristic"
    sample_count: int = Field(default=4, ge=1)
    self_temperatures: list[float] = Field(default_factory=lambda: [0.2, 0.4, 0.6, 0.8])
    panel_models: list[str] = Field(default_factory=list)
    sampling: SamplingConfig = Field(default_factory=SamplingConfig)
    budget: RunBudget = Field(default_factory=RunBudget)
    context: ContextPolicy = Field(default_factory=ContextPolicy)
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

    @model_validator(mode="after")
    def _validate_model_references(self) -> FusionConfig:
        endpoint_ids = [endpoint.id for endpoint in self.endpoints]
        known = set(endpoint_ids)
        if len(known) != len(endpoint_ids):
            raise ValueError("endpoint ids must be unique")
        references = {
            "default_model": self.default_model,
            "judge_model": self.judge_model,
            "synthesizer_model": self.synthesizer_model,
        }
        for field, model_id in references.items():
            if model_id is not None and model_id not in known:
                raise ValueError(f"{field} references unknown endpoint {model_id!r}")
        if len(set(self.panel_models)) != len(self.panel_models):
            raise ValueError("panel_models must not contain duplicates")
        unknown_panel = [model_id for model_id in self.panel_models if model_id not in known]
        if unknown_panel:
            raise ValueError(
                f"panel_models reference unknown endpoints: {', '.join(unknown_panel)}"
            )
        return self

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


_PROMPT_FILE_FIELDS = {
    "judge_system": "judge.md",
    "synthesizer_system": "synthesizer.md",
}


def load_config(path: str | Path) -> FusionConfig:
    config_path = Path(path)
    data = yaml.safe_load(config_path.read_text()) or {}
    _apply_prompt_file_overrides(data, config_path)
    return FusionConfig.model_validate(data)


def _apply_prompt_file_overrides(data: object, config_path: Path) -> None:
    if not isinstance(data, dict):
        return
    prompts = data.setdefault("prompts", {})
    if not isinstance(prompts, dict):
        return
    prompt_dirs = [
        config_path.parent / ".fusionkit" / "prompts",
        Path.cwd() / ".fusionkit" / "prompts",
    ]
    for field, filename in _PROMPT_FILE_FIELDS.items():
        if prompts.get(field) is not None:
            continue
        for prompt_dir in prompt_dirs:
            prompt_path = prompt_dir / filename
            if prompt_path.exists():
                prompts[field] = prompt_path.read_text(encoding="utf-8").rstrip("\n")
                break
