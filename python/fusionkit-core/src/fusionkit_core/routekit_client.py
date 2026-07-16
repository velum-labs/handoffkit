from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Any

import httpx

from fusionkit_core.config import SamplingConfig
from fusionkit_core.model_client import ToolChoice, ToolDefinition
from fusionkit_core.types import ChatMessage, ModelResponse, StreamChunk, ToolCall, Usage

_RESERVED_PAYLOAD_FIELDS = frozenset(
    {"model", "messages", "stream", "stream_options", "tools", "tool_choice"}
)


def _chat_url(gateway_url: str) -> str:
    base = gateway_url.rstrip("/")
    if base.endswith("/v1"):
        return f"{base}/chat/completions"
    return f"{base}/v1/chat/completions"


def _messages(messages: Sequence[ChatMessage]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for message in messages:
        item: dict[str, Any] = {"role": message.role, "content": message.content}
        if message.name is not None:
            item["name"] = message.name
        if message.tool_call_id is not None:
            item["tool_call_id"] = message.tool_call_id
        if message.tool_calls:
            item["tool_calls"] = [
                {
                    "id": call.id,
                    "type": "function",
                    "function": {"name": call.name, "arguments": call.arguments},
                }
                for call in message.tool_calls
            ]
        output.append(item)
    return output


def _tools(tools: Sequence[ToolDefinition]) -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": tool["name"],
                "description": tool.get("description", ""),
                "parameters": tool.get("parameters", {"type": "object", "properties": {}}),
            },
        }
        for tool in tools
    ]


def _tool_choice(choice: ToolChoice) -> Any:
    if isinstance(choice, str):
        return choice
    return {"type": "function", "function": {"name": choice["name"]}}


def _usage(value: object) -> Usage:
    if not isinstance(value, Mapping):
        return Usage()
    return Usage(
        prompt_tokens=_int_or_none(value.get("prompt_tokens")),
        completion_tokens=_int_or_none(value.get("completion_tokens")),
        total_tokens=_int_or_none(value.get("total_tokens")),
    )


def _int_or_none(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _tool_calls(value: object, *, streamed: bool = False) -> list[ToolCall]:
    if not isinstance(value, list):
        return []
    output: list[ToolCall] = []
    for item in value:
        if not isinstance(item, Mapping):
            continue
        function = item.get("function")
        if not isinstance(function, Mapping):
            continue
        index = item.get("index")
        output.append(
            ToolCall(
                id=str(item.get("id") or ""),
                name=str(function.get("name") or ""),
                arguments=str(function.get("arguments") or ("" if streamed else "{}")),
                index=index if streamed and isinstance(index, int) else None,
            )
        )
    return output


def _reasoning(value: object) -> str | None:
    if not isinstance(value, Mapping):
        return None
    for field in ("reasoning", "reasoning_content"):
        text = value.get(field)
        if isinstance(text, str) and text:
            return text
    return None


async def _sse_data(response: httpx.Response) -> AsyncIterator[str]:
    """Yield complete SSE ``data`` fields independent of byte/line chunking."""
    data_lines: list[str] = []
    async for line in response.aiter_lines():
        if not line:
            if data_lines:
                yield "\n".join(data_lines)
                data_lines.clear()
            continue
        if line.startswith(":"):
            continue
        field, separator, value = line.partition(":")
        if field != "data":
            continue
        if separator and value.startswith(" "):
            value = value[1:]
        data_lines.append(value)
    if data_lines:
        yield "\n".join(data_lines)


class RouteKitClient:
    """Thin client for RouteKit's neutral OpenAI-compatible gateway."""

    def __init__(
        self,
        gateway_url: str,
        endpoint_id: str,
        *,
        timeout_s: float = 120.0,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self.model_id = endpoint_id
        self.max_context: int | None = None
        self._url = _chat_url(gateway_url)
        self._client = http_client or httpx.AsyncClient(timeout=timeout_s)
        self._owns_client = http_client is None

    def _payload(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig,
        tools: Sequence[ToolDefinition] | None,
        tool_choice: ToolChoice | None,
        extra: Mapping[str, Any] | None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self.model_id,
            "messages": _messages(messages),
            "temperature": sampling.temperature,
            "top_p": sampling.top_p,
            "max_tokens": sampling.max_tokens,
        }
        if sampling.seed is not None:
            payload["seed"] = sampling.seed
        if tools:
            payload["tools"] = _tools(tools)
        if tool_choice is not None:
            payload["tool_choice"] = _tool_choice(tool_choice)
        if extra:
            reserved = _RESERVED_PAYLOAD_FIELDS.intersection(extra)
            if reserved:
                names = ", ".join(sorted(reserved))
                raise ValueError(f"RouteKit payload extras cannot override: {names}")
            payload.update(extra)
        return payload

    async def chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[ToolDefinition] | None = None,
        tool_choice: ToolChoice | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> ModelResponse:
        started = time.perf_counter()
        response = await self._client.post(
            self._url,
            json=self._payload(
                messages, sampling or SamplingConfig(), tools, tool_choice, extra
            ),
        )
        response.raise_for_status()
        body = response.json()
        choices = body.get("choices") if isinstance(body, Mapping) else None
        if not isinstance(choices, list) or not choices or not isinstance(choices[0], Mapping):
            raise ValueError("RouteKit returned no completion choices")
        choice = choices[0]
        message = choice.get("message")
        if not isinstance(message, Mapping):
            raise ValueError("RouteKit returned an invalid completion message")
        return ModelResponse(
            model_id=self.model_id,
            content=str(message.get("content") or ""),
            finish_reason=(
                str(choice["finish_reason"]) if choice.get("finish_reason") is not None else None
            ),
            usage=_usage(body.get("usage")),
            latency_s=time.perf_counter() - started,
            tool_calls=_tool_calls(message.get("tool_calls")),
            raw=dict(body),
            reasoning=_reasoning(message),
        )

    async def stream_chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[ToolDefinition] | None = None,
        tool_choice: ToolChoice | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> AsyncIterator[StreamChunk]:
        payload = self._payload(
            messages, sampling or SamplingConfig(), tools, tool_choice, extra
        )
        payload["stream"] = True
        payload["stream_options"] = {"include_usage": True}
        async with self._client.stream("POST", self._url, json=payload) as response:
            response.raise_for_status()
            done = False
            async for data in _sse_data(response):
                if not data:
                    continue
                if data.strip() == "[DONE]":
                    done = True
                    break
                try:
                    event = json.loads(data)
                except json.JSONDecodeError as exc:
                    raise ValueError("RouteKit returned malformed SSE JSON") from exc
                if not isinstance(event, Mapping):
                    continue
                usage = _usage(event.get("usage")) if event.get("usage") is not None else None
                choices = event.get("choices")
                if not isinstance(choices, list) or not choices:
                    if usage is not None:
                        yield StreamChunk(usage=usage)
                    continue
                choice = choices[0]
                if not isinstance(choice, Mapping):
                    continue
                delta = choice.get("delta")
                delta = delta if isinstance(delta, Mapping) else {}
                fragments = _tool_calls(delta.get("tool_calls"), streamed=True)
                yield StreamChunk(
                    delta=str(delta.get("content") or ""),
                    tool_call_delta=fragments[0] if fragments else None,
                    finish_reason=(
                        str(choice["finish_reason"])
                        if choice.get("finish_reason") is not None
                        else None
                    ),
                    usage=usage,
                    model_reasoning_delta=_reasoning(delta),
                )
                for fragment in fragments[1:]:
                    yield StreamChunk(tool_call_delta=fragment)
            if not done:
                raise ValueError("RouteKit stream ended before [DONE]")

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()


__all__ = ["RouteKitClient"]
