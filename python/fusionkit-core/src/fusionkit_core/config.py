from __future__ import annotations

from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, Field, field_validator

FusionMode = Literal["single", "self", "panel", "router"]


class SamplingConfig(BaseModel):
    temperature: float = 0.2
    top_p: float = 0.95
    max_tokens: int = 1024
    seed: int | None = None


class ModelEndpoint(BaseModel):
    id: str
    model: str
    base_url: str
    api_key: str = "not-needed"
    max_context: int | None = None
    estimated_memory_gb: float | None = None
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
