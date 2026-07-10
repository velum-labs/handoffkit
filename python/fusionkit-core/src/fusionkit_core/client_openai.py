from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Any

import httpx
from openai import AsyncOpenAI

from fusionkit_core.client_errors import ProviderCallError, _call_with_retries
from fusionkit_core.client_types import ToolChoice, ToolDefinition
from fusionkit_core.client_wire import (
    _openai_messages,
    _openai_stream_tool_calls,
    _openai_tool_calls,
    _openai_tool_choice,
    _openai_tools,
    _openrouter_provider_cost_from_generation,
    _reasoning_text,
    _usage_with_provider_cost,
)
from fusionkit_core.config import ModelEndpoint, SamplingConfig
from fusionkit_core.providers import resolve_api_key
from fusionkit_core.registry import (
    OPENROUTER_ATTRIBUTION_HEADERS,
    provider_request_shape,
    reasoning_request_for,
)
from fusionkit_core.types import ChatMessage, ModelResponse, ProviderCost, StreamChunk, Usage


class OpenAICompatibleClient:
    """Client for any OpenAI Chat Completions compatible endpoint.

    Covers the ``openai``, ``openrouter``, ``openai-compatible``, ``mlx-lm``
    and ``custom`` providers, all of which speak the OpenAI Chat Completions
    wire format.
    """

    def __init__(self, endpoint: ModelEndpoint) -> None:
        self.endpoint = endpoint
        self.model_id = endpoint.id
        self.max_context = endpoint.max_context
        default_headers = (
            OPENROUTER_ATTRIBUTION_HEADERS if endpoint.provider == "openrouter" else None
        )
        self._client = AsyncOpenAI(
            base_url=f"{endpoint.base_url}/v1",
            api_key=resolve_api_key(endpoint),
            timeout=endpoint.timeout_s,
            default_headers=default_headers,
        )
        self._openrouter_http: httpx.AsyncClient | None = None

    def _openrouter_http_client(self) -> httpx.AsyncClient:
        if self._openrouter_http is None:
            self._openrouter_http = httpx.AsyncClient(timeout=min(self.endpoint.timeout_s, 10.0))
        return self._openrouter_http

    async def _openrouter_provider_cost(self, generation_id: str | None) -> ProviderCost | None:
        if self.endpoint.provider != "openrouter":
            return None
        if not generation_id:
            return ProviderCost(source="provider", lookup_status="missing_generation_id")
        url = f"{self.endpoint.base_url.rstrip('/')}/v1/generation"
        headers = {
            "Authorization": f"Bearer {resolve_api_key(self.endpoint)}",
            **OPENROUTER_ATTRIBUTION_HEADERS,
        }
        last_status = "unavailable"
        client = self._openrouter_http_client()
        for attempt in range(3):
            try:
                response = await client.get(url, params={"id": generation_id}, headers=headers)
            except httpx.HTTPError as exc:
                return ProviderCost(
                    source="provider",
                    generation_id=generation_id,
                    lookup_status=f"error:{exc.__class__.__name__}",
                )
            if response.status_code == 200:
                payload = response.json()
                data = payload.get("data") if isinstance(payload, dict) else None
                if isinstance(data, dict):
                    return _openrouter_provider_cost_from_generation(generation_id, data)
                return ProviderCost(
                    source="provider",
                    generation_id=generation_id,
                    lookup_status="malformed_response",
                )
            if response.status_code == 404:
                last_status = "not_ready"
                if attempt < 2:
                    await asyncio.sleep(0.2 * (attempt + 1))
                continue
            last_status = f"http_{response.status_code}"
            break
        return ProviderCost(
            source="provider",
            generation_id=generation_id,
            lookup_status=last_status,
        )

    def _payload(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig,
        tools: Sequence[ToolDefinition] | None,
        tool_choice: ToolChoice | None,
        extra: Mapping[str, Any] | None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self.endpoint.model,
            "messages": _openai_messages(messages),
        }
        request_shape = provider_request_shape(self.endpoint.provider)
        max_tokens_param = str(request_shape.get("maxTokensParam", "max_tokens"))
        payload[max_tokens_param] = sampling.max_tokens
        if not request_shape.get("omitSampling", False):
            payload["temperature"] = sampling.temperature
            payload["top_p"] = sampling.top_p
            if sampling.seed is not None:
                payload["seed"] = sampling.seed
        if tools:
            payload["tools"] = _openai_tools(tools)
        if tool_choice is not None:
            payload["tool_choice"] = _openai_tool_choice(tool_choice)
        reasoning_request = reasoning_request_for(self.endpoint.provider, self.endpoint.model)
        if reasoning_request is not None:
            # OpenRouter exposes reasoning for Kimi via its unified `reasoning`
            # request object. Keep this narrowly scoped so non-reasoning
            # OpenRouter models preserve their current request shape, and let
            # explicit caller overrides win below.
            payload["reasoning"] = reasoning_request
        if extra:
            payload.update(extra)
        # `reasoning` is an OpenRouter extension, not an OpenAI parameter: the
        # SDK's typed `create()` rejects unknown top-level kwargs, so it must
        # ride in `extra_body` to reach the wire. An explicit
        # `extra_body.reasoning` from the caller still wins.
        reasoning = payload.pop("reasoning", None)
        if reasoning is not None:
            extra_body = dict(payload.get("extra_body") or {})
            extra_body.setdefault("reasoning", reasoning)
            payload["extra_body"] = extra_body
        return payload

    async def chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[ToolDefinition] | None = None,
        tool_choice: ToolChoice | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> ModelResponse:
        payload = self._payload(messages, sampling or SamplingConfig(), tools, tool_choice, extra)
        started = time.perf_counter()
        response = await _call_with_retries(
            lambda: self._client.chat.completions.create(**payload),
            provider=self.endpoint.provider,
            model_id=self.model_id,
        )
        latency_s = time.perf_counter() - started
        if not response.choices:
            raise ProviderCallError(
                "provider returned no completion choices",
                category="unknown",
                provider=self.endpoint.provider,
                model_id=self.model_id,
            )
        choice = response.choices[0]
        usage = Usage()
        if response.usage is not None:
            usage = Usage(
                prompt_tokens=response.usage.prompt_tokens,
                completion_tokens=response.usage.completion_tokens,
                total_tokens=response.usage.total_tokens,
            )
        provider_cost = await self._openrouter_provider_cost(getattr(response, "id", None))
        if provider_cost is not None:
            usage = _usage_with_provider_cost(usage, provider_cost)
        return ModelResponse(
            model_id=self.model_id,
            content=choice.message.content or "",
            finish_reason=choice.finish_reason,
            usage=usage,
            latency_s=latency_s,
            tool_calls=_openai_tool_calls(getattr(choice.message, "tool_calls", None)),
            raw=response.model_dump(mode="json"),
            provider_cost=provider_cost,
            reasoning=_reasoning_text(choice.message),
        )

    async def stream_chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[ToolDefinition] | None = None,
        tool_choice: ToolChoice | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> AsyncIterator[StreamChunk]:
        payload = self._payload(messages, sampling or SamplingConfig(), tools, tool_choice, extra)
        payload["stream"] = True
        if self.endpoint.provider == "openai":
            payload.setdefault("stream_options", {"include_usage": True})
        stream = await _call_with_retries(
            lambda: self._client.chat.completions.create(**payload),
            provider=self.endpoint.provider,
            model_id=self.model_id,
        )
        generation_id: str | None = None
        terminal_usage: Usage | None = None
        async for event in stream:
            if generation_id is None:
                generation_id = getattr(event, "id", None)
            usage = None
            if getattr(event, "usage", None) is not None:
                usage = Usage(
                    prompt_tokens=event.usage.prompt_tokens,
                    completion_tokens=event.usage.completion_tokens,
                    total_tokens=event.usage.total_tokens,
                )
                terminal_usage = usage
            if not event.choices:
                if usage is not None:
                    yield StreamChunk(usage=usage)
                continue
            choice = event.choices[0]
            delta = choice.delta
            fragments = _openai_stream_tool_calls(getattr(delta, "tool_calls", None))
            yield StreamChunk(
                delta=(delta.content or "") if delta is not None else "",
                tool_call_delta=fragments[0] if fragments else None,
                finish_reason=choice.finish_reason,
                usage=usage,
                model_reasoning_delta=_reasoning_text(delta),
            )
            # A single SSE chunk may carry fragments for several tool-call
            # slots (parallel calls); emit each one so none are dropped.
            for fragment in fragments[1:]:
                yield StreamChunk(tool_call_delta=fragment)
        provider_cost = await self._openrouter_provider_cost(generation_id)
        if provider_cost is not None:
            yield StreamChunk(
                usage=_usage_with_provider_cost(terminal_usage, provider_cost),
                provider_cost=provider_cost,
            )

    async def aclose(self) -> None:
        await self._client.close()
        if self._openrouter_http is not None:
            await self._openrouter_http.aclose()
            self._openrouter_http = None

