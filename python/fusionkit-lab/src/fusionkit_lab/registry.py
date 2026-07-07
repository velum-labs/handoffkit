"""Pinned model identities keep lab comparisons auditable across provider changes.

Historical analysis scripts carried endpoint dictionaries inline, which made it
easy for behavior-changing edits to slip into a run. The registry centralizes
those identities and gives downstream records a compact hash of the fields that
actually affect model behavior.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field, model_validator


class ModelIdentity(BaseModel):
    endpoint_id: str
    provider: str
    model: str
    base_url: str
    api_key_env: str
    input_price_per_m: float
    output_price_per_m: float
    max_completion_tokens: int
    escalated_completion_tokens: int | None
    lineage: list[str] = Field(default_factory=list)
    generation: str


class ModelRegistry(BaseModel):
    cycle_id: str
    models: list[ModelIdentity] = Field(default_factory=list)

    @model_validator(mode="after")
    def _reject_duplicate_endpoint_ids(self) -> ModelRegistry:
        seen: set[str] = set()
        duplicates: list[str] = []
        for model in self.models:
            if model.endpoint_id in seen:
                duplicates.append(model.endpoint_id)
            seen.add(model.endpoint_id)
        if duplicates:
            duplicate_list = ", ".join(sorted(set(duplicates)))
            raise ValueError(f"duplicate endpoint_id in registry: {duplicate_list}")
        return self

    def get(self, endpoint_id: str) -> ModelIdentity:
        for model in self.models:
            if model.endpoint_id == endpoint_id:
                return model
        available = ", ".join(model.endpoint_id for model in self.models) or "<none>"
        raise KeyError(f"unknown endpoint_id {endpoint_id!r}; available endpoints: {available}")


def load_registry(path: str | Path) -> ModelRegistry:
    registry_path = Path(path)
    if not registry_path.exists():
        raise FileNotFoundError(f"registry file not found: {registry_path}")
    data = yaml.safe_load(registry_path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"registry file must contain a YAML mapping: {registry_path}")
    return ModelRegistry.model_validate(data)


def identity_hash(model: ModelIdentity) -> str:
    """Return a 16-char sha256 prefix over behavior-pinning identity fields.

    Prices, lineage, generation, endpoint handles, and API key environment names
    are intentionally excluded because they affect accounting or metadata, not
    the sampled completion behavior. Sorted-key JSON makes the hash stable across
    Python and YAML serialization details.
    """

    payload: dict[str, Any] = {
        "base_url": model.base_url,
        "escalated_completion_tokens": model.escalated_completion_tokens,
        "max_completion_tokens": model.max_completion_tokens,
        "model": model.model,
        "provider": model.provider,
    }
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()
    return digest[:16]


def lineage_conflicts(a: ModelIdentity, b: ModelIdentity) -> bool:
    return bool(set(a.lineage).intersection(b.lineage))


__all__ = [
    "ModelIdentity",
    "ModelRegistry",
    "identity_hash",
    "lineage_conflicts",
    "load_registry",
]
