from __future__ import annotations

import asyncio
from typing import assert_never

import httpx

from fusionkit_core.client_anthropic import AnthropicModelClient
from fusionkit_core.client_codex import CodexResponsesClient
from fusionkit_core.client_errors import (
    DEFAULT_RETRY_BASE_DELAY_S,
    DEFAULT_RETRY_MAX_ATTEMPTS,
    DEFAULT_RETRY_MAX_DELAY_S,
    ProviderCallError,
    ProviderErrorCategory,
    _call_with_retries,
    classify_provider_error,
)
from fusionkit_core.client_fake import FakeModelClient
from fusionkit_core.client_google import GoogleModelClient
from fusionkit_core.client_openai import OpenAICompatibleClient
from fusionkit_core.client_types import ChatClient, ToolChoice, ToolDefinition
from fusionkit_core.client_wire import (
    _anthropic_messages,
    _anthropic_tool_choice,
    _anthropic_tools,
    _codex_input,
    _codex_tool_choice,
    _codex_tools,
    _codex_usage,
    _google_contents,
    _google_extract,
    _google_tool_config,
    _google_tools,
    _loads_arguments,
    _openai_messages,
    _openai_stream_tool_calls,
    _openai_tool_calls,
    _openai_tool_choice,
    _openai_tools,
    _openrouter_provider_cost_from_generation,
    _reasoning_text,
    _usage_with_provider_cost,
)
from fusionkit_core.config import FusionConfig, ModelEndpoint

_COMPAT_PATCH_MODULES = (asyncio, httpx)

# Backwards-compatible alias: the original name used before native cloud
# clients were introduced.
LocalModelClient = OpenAICompatibleClient


def build_client(endpoint: ModelEndpoint) -> ChatClient:
    """Construct the right :class:`ChatClient` for an endpoint's provider."""
    match endpoint.provider:
        case "openai" | "openrouter" | "openai-compatible" | "mlx-lm" | "custom":
            return OpenAICompatibleClient(endpoint)
        case "anthropic":
            return AnthropicModelClient(endpoint)
        case "google":
            return GoogleModelClient(endpoint)
        case "codex":
            return CodexResponsesClient(endpoint)
        case _ as unreachable:
            assert_never(unreachable)


def build_clients(config: FusionConfig) -> dict[str, ChatClient]:
    return {endpoint.id: build_client(endpoint) for endpoint in config.endpoints}


__all__ = [
    "AnthropicModelClient",
    "ChatClient",
    "CodexResponsesClient",
    "DEFAULT_RETRY_BASE_DELAY_S",
    "DEFAULT_RETRY_MAX_ATTEMPTS",
    "DEFAULT_RETRY_MAX_DELAY_S",
    "FakeModelClient",
    "GoogleModelClient",
    "LocalModelClient",
    "OpenAICompatibleClient",
    "ProviderCallError",
    "ProviderErrorCategory",
    "ToolChoice",
    "ToolDefinition",
    "_anthropic_messages",
    "_anthropic_tool_choice",
    "_anthropic_tools",
    "_call_with_retries",
    "_codex_input",
    "_codex_tool_choice",
    "_codex_tools",
    "_codex_usage",
    "_google_contents",
    "_google_extract",
    "_google_tool_config",
    "_google_tools",
    "_loads_arguments",
    "_openai_messages",
    "_openai_stream_tool_calls",
    "_openai_tool_calls",
    "_openai_tool_choice",
    "_openai_tools",
    "_openrouter_provider_cost_from_generation",
    "_reasoning_text",
    "_usage_with_provider_cost",
    "build_client",
    "build_clients",
    "classify_provider_error",
]
