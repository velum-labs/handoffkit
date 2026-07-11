"""Helpers for fronting a single provider model as an OpenAI Chat Completions endpoint.

``build_endpoint`` constructs a :class:`ModelEndpoint` from CLI flags. The
``fusionkit serve-endpoint`` command serves it via the shared FastAPI app
(``create_app`` + uvicorn), which exposes passthrough chat-completions for one
model id — including streaming and dict ``tool_choice`` handling.

``_to_tools`` and ``_astream_sse`` remain for unit tests that exercise tool
normalization and SSE framing without standing up the full server.
"""
from __future__ import annotations

import json
import time
import uuid
from collections.abc import AsyncIterator, Sequence
from typing import Any, cast

from fusionkit_core.client_types import ToolChoice, ToolDefinition
from fusionkit_core.clients import ChatClient
from fusionkit_core.config import (
    EndpointAuth,
    ModelEndpoint,
    ProviderKind,
    SamplingConfig,
    SubscriptionAuthMode,
)
from fusionkit_core.judge import accumulate_tool_call, warn_malformed_tool_calls
from fusionkit_core.registry import PROVIDER_DEFAULT_BASE_URL
from fusionkit_core.types import ChatMessage, ToolCall


def _to_tools(tools: Any) -> list[dict[str, Any]] | None:
    """Flatten tool defs like the fusion server's ``_normalize_tools``: nested
    or flat function tools keep their name, typed nameless tools (e.g.
    ``{type: "tool_search"}``) are projected under their type, and entries with
    no resolvable identity are skipped (never emitted with ``name: ""``, which
    providers reject)."""
    if not tools:
        return None
    converted = []
    for entry in tools:
        if not isinstance(entry, dict):
            continue
        function = entry.get("function", entry)
        if not isinstance(function, dict):
            continue
        name = function.get("name", "")
        if not (isinstance(name, str) and name):
            kind = entry.get("type", "")
            name = kind if isinstance(kind, str) and kind not in ("", "function", "custom") else ""
        if not name:
            continue
        converted.append(
            {
                "name": name,
                "description": function.get("description", ""),
                "parameters": function.get("parameters", {"type": "object", "properties": {}}),
            }
        )
    return converted or None


async def _astream_sse(
    client: ChatClient,
    model: str,
    messages: Sequence[ChatMessage],
    sampling: SamplingConfig,
    tools: Sequence[ToolDefinition] | None,
    tool_choice: ToolChoice | None,
) -> AsyncIterator[str]:
    """Stream a single endpoint's response as OpenAI chat.completion.chunk SSE.

    True token streaming from the provider's ``stream_chat`` (not buffer-then-
    rechunk). Tool-call fragments are normalized via the same
    :func:`accumulate_tool_call` seam the unified server uses, then emitted whole
    before the terminal chunk.
    """
    completion_id = f"chatcmpl-{uuid.uuid4()}"
    created = int(time.time())

    def chunk(delta: dict[str, Any], finish: str | None) -> str:
        payload = {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
        }
        return f"data: {json.dumps(payload)}\n\n"

    yield chunk({"role": "assistant"}, None)
    tool_accumulator: list[dict[str, str]] = []
    seen_tool_ids: set[str] = set()
    finish_reason: str | None = None
    usage: dict[str, Any] | None = None
    provider_cost: dict[str, Any] | None = None
    async for piece in client.stream_chat(messages, sampling, tools=tools, tool_choice=tool_choice):
        if piece.delta:
            yield chunk({"content": piece.delta}, None)
        if piece.tool_call_delta is not None:
            accumulate_tool_call(tool_accumulator, seen_tool_ids, piece.tool_call_delta)
        if piece.finish_reason is not None:
            finish_reason = piece.finish_reason
        if piece.usage is not None:
            usage = piece.usage.model_dump(mode="json", exclude_none=True)
        if piece.provider_cost is not None:
            provider_cost = piece.provider_cost.model_dump(mode="json", exclude_none=True)
    tool_calls = [
        {
            "id": item["id"] or f"call_{index}",
            "type": "function",
            "function": {"name": item["name"], "arguments": item["arguments"] or "{}"},
        }
        for index, item in enumerate(tool_accumulator)
    ]
    warn_malformed_tool_calls(
        [
            ToolCall(id=item["id"], name=item["name"], arguments=item["arguments"] or "{}")
            for item in tool_accumulator
        ],
        source=f"endpoint sse ({model})",
    )
    if tool_calls:
        yield chunk(
            {"tool_calls": [{"index": index, **call} for index, call in enumerate(tool_calls)]},
            None,
        )
    payload = {
        "id": completion_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [
            {
                "index": 0,
                "delta": {},
                "finish_reason": "tool_calls" if tool_calls else (finish_reason or "stop"),
            }
        ],
    }
    if usage is not None:
        payload["usage"] = usage
    if provider_cost is not None:
        payload["provider_cost"] = provider_cost
    yield f"data: {json.dumps(payload)}\n\n"
    yield "data: [DONE]\n\n"


def build_endpoint(
    *,
    id: str,
    model: str,
    provider: str = "openai",
    base_url: str | None = None,
    api_key_env: str | None = None,
    timeout_s: float = 120.0,
    auth_mode: str = "api_key",
    credentials_path: str | None = None,
) -> ModelEndpoint:
    resolved_base_url = base_url or PROVIDER_DEFAULT_BASE_URL.get(provider)
    if resolved_base_url is None:
        raise ValueError(
            f"provider {provider!r} needs --base-url because it has no registry default"
        )
    # `provider` / `auth_mode` arrive as free strings from the CLI; ModelEndpoint
    # validates them against their Literal types at construction time (pydantic
    # raises on misuse).
    return ModelEndpoint(
        id=id,
        model=model,
        base_url=resolved_base_url,
        provider=cast(ProviderKind, provider),
        api_key_env=api_key_env,
        timeout_s=timeout_s,
        auth=EndpointAuth(
            mode=cast(SubscriptionAuthMode, auth_mode),
            credentials_path=credentials_path,
        ),
    )
