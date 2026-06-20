from __future__ import annotations

import os
from typing import Any

from fusionkit_core.config import ModelEndpoint
from fusionkit_core.contracts import ContractUsage, ModelEndpointV1, contract_metadata
from fusionkit_core.types import Usage


def resolve_api_key(endpoint: ModelEndpoint) -> str:
    if endpoint.api_key_env:
        value = os.environ.get(endpoint.api_key_env)
        if not value:
            raise ValueError(
                f"Endpoint {endpoint.id!r} sets api_key_env="
                f"{endpoint.api_key_env!r} but that environment variable is "
                "unset or empty."
            )
        return value
    return endpoint.api_key


def endpoint_to_contract(endpoint: ModelEndpoint) -> ModelEndpointV1:
    return ModelEndpointV1.model_validate(
        {
            **contract_metadata("model_endpoint.v1"),
            "endpoint_id": endpoint.id,
            "owner": "fusionkit",
            "provider": endpoint.provider,
            "model": endpoint.model,
            "base_url": endpoint.base_url,
            "api_compatibility": _api_compatibility(endpoint),
            "capabilities": {
                "structured_output": _capability(endpoint.capabilities.structured_output),
                "tool_calls": _capability(endpoint.capabilities.tool_calls),
                "streaming": _capability(endpoint.capabilities.streaming),
            },
            "max_context_tokens": endpoint.max_context,
            "estimated_memory_gb": endpoint.estimated_memory_gb,
            "tags": endpoint.tags,
            "status": "succeeded",
        }
    )


def normalize_usage(usage: Usage | ContractUsage | dict[str, Any] | None) -> ContractUsage | None:
    if usage is None:
        return None
    if isinstance(usage, ContractUsage):
        return usage
    if isinstance(usage, Usage):
        return ContractUsage.model_validate(usage.model_dump(mode="json"))
    if isinstance(usage, dict):
        return ContractUsage.model_validate(usage)
    return None


def estimate_cost(
    endpoint: ModelEndpoint,
    usage: Usage | ContractUsage | dict[str, Any] | None,
) -> float | None:
    normalized = normalize_usage(usage)
    if normalized is None:
        return None
    if (
        normalized.prompt_tokens is None
        or normalized.completion_tokens is None
        or endpoint.pricing.input_per_1m_tokens is None
        or endpoint.pricing.output_per_1m_tokens is None
    ):
        return None
    input_cost = normalized.prompt_tokens * endpoint.pricing.input_per_1m_tokens / 1_000_000
    output_cost = normalized.completion_tokens * endpoint.pricing.output_per_1m_tokens / 1_000_000
    return input_cost + output_cost


def provider_metadata(
    endpoint: ModelEndpoint | None,
    usage: Usage | ContractUsage | dict[str, Any] | None,
) -> dict[str, Any]:
    normalized = normalize_usage(usage)
    metadata: dict[str, Any] = {
        "unknown_usage": normalized is None,
        "unknown_cost": True,
        "cost_estimate": None,
    }
    if endpoint is None:
        return metadata
    cost_estimate = estimate_cost(endpoint, normalized)
    metadata.update(
        {
            "provider": endpoint.provider,
            "endpoint_id": endpoint.id,
            "model": endpoint.model,
            "max_context": endpoint.max_context,
            "structured_output": endpoint.capabilities.structured_output,
            "tool_support": endpoint.capabilities.tool_calls,
            "timeout_s": endpoint.timeout_s,
            "pricing": endpoint.pricing.model_dump(mode="json"),
            "cost_estimate": cost_estimate,
            "unknown_cost": cost_estimate is None,
        }
    )
    return metadata


def _api_compatibility(endpoint: ModelEndpoint) -> str:
    # The model_endpoint.v1 contract enum only allows openai-chat-completions,
    # openai-responses, mlx-lm-server and custom. Native Anthropic/Google
    # providers therefore map to "custom" until the versioned contract grows
    # dedicated wire-format values.
    if endpoint.provider == "mlx-lm":
        return "mlx-lm-server"
    if endpoint.provider in ("openai", "openai-compatible"):
        return "openai-chat-completions"
    return "custom"


def _capability(value: bool | None) -> str:
    if value is True:
        return "supported"
    if value is False:
        return "unsupported"
    return "unknown"


__all__ = [
    "endpoint_to_contract",
    "estimate_cost",
    "normalize_usage",
    "provider_metadata",
    "resolve_api_key",
]
