"""FusionKit configuration models and loaders.

Prompt precedence is: per-request overrides > YAML ``prompts`` fields >
``.fusionkit/prompts/{judge,synthesizer}.md`` beside the config file (or the
current working directory when serving from elsewhere) > built-in defaults.
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

FusionMode = Literal["single", "self", "panel", "heuristic"]


class RunBudget(BaseModel):
    model_config = ConfigDict(extra="forbid")

    max_candidates: int | None = Field(default=None, ge=1)
    wall_clock_s: float | None = Field(default=None, ge=0)
    max_tool_rounds: int | None = Field(default=None, ge=0)
    max_tool_calls: int | None = Field(default=None, ge=0)


class ContextPolicy(BaseModel):
    """How judge/synthesizer prompts are budgeted against a model's context window.

    ``default_max_context`` is the sidecar's model-agnostic context budget.
    ``safety_margin_tokens`` absorbs token-estimation error (the estimator is a
    chars/4 heuristic, which under-counts dense code). ``keep_head_items`` /
    ``keep_tail_items`` control middle-out trajectory packing: the first items
    (the plan) and the last items (the outcome) survive, the middle is elided.
    """

    model_config = ConfigDict(extra="forbid")

    default_max_context: int = Field(default=64_000, ge=1_024)
    safety_margin_tokens: int = Field(default=2_048, ge=0)
    keep_head_items: int = Field(default=8, ge=0)
    keep_tail_items: int = Field(default=12, ge=0)


class SamplingConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    temperature: float = Field(default=0.2, ge=0, le=2)
    top_p: float = Field(default=0.95, gt=0, le=1)
    max_tokens: int = Field(default=1024, ge=1)
    seed: int | None = None


def merge_sampling(
    override: SamplingConfig | None, fallback: SamplingConfig
) -> SamplingConfig:
    """Overlay request sampling onto config defaults, field by field.

    Only fields the caller explicitly set replace the fallback; everything
    else keeps the operator-configured value. Explicit values remain overrides
    even when they equal this model's generic defaults.
    """
    if override is None:
        return fallback
    updates = {
        field_name: getattr(override, field_name)
        for field_name in override.model_fields_set
    }
    return fallback.model_copy(update=updates)


class PromptOverrides(BaseModel):
    """Optional overrides for the built-in fusion system prompts.

    Each field defaults to ``None``, which means "use the built-in constant in
    ``prompts.py``". A non-null value fully replaces that system prompt. This is
    the surface that lets a committed ``.fusionkit/prompts/*.md`` file flow all
    the way into the synthesizer via the router config the CLI generates.
    """

    model_config = ConfigDict(extra="forbid")

    judge_system: str | None = None
    synthesizer_system: str | None = None


class FusionConfig(BaseModel):
    """Configuration for the internal synthesis sidecar.

    RouteKit owns accounts, providers, retries, balancing, and pricing. FusionKit
    receives only its neutral OpenAI-compatible gateway URL and opaque endpoint
    identifiers.
    """

    model_config = ConfigDict(extra="forbid")

    routekit_url: str
    endpoint_ids: list[str] = Field(min_length=1)
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

    @field_validator("routekit_url")
    @classmethod
    def normalize_routekit_url(cls, value: str) -> str:
        normalized = value.rstrip("/")
        if not normalized:
            raise ValueError("routekit_url must not be empty")
        return normalized

    @model_validator(mode="after")
    def _validate_model_references(self) -> FusionConfig:
        known = set(self.endpoint_ids)
        if len(known) != len(self.endpoint_ids):
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

    def require_endpoint(self, endpoint_id: str) -> str:
        if endpoint_id not in self.endpoint_ids:
            raise KeyError(f"Unknown RouteKit endpoint: {endpoint_id}")
        return endpoint_id

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
