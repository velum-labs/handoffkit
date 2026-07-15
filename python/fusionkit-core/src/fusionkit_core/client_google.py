from __future__ import annotations

import contextlib
import time
from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Any

from google import genai
from google.genai import types as genai_types

from fusionkit_core.client_errors import _call_with_retries
from fusionkit_core.client_types import (
    ToolChoice,
    ToolDefinition,
    reject_openrouter_request_fields,
)
from fusionkit_core.client_wire import (
    _google_contents,
    _google_extract,
    _google_tool_config,
    _google_tools,
)
from fusionkit_core.config import ModelEndpoint, SamplingConfig
from fusionkit_core.providers import resolve_api_key
from fusionkit_core.types import ChatMessage, ModelResponse, StreamChunk, Usage


class GoogleModelClient:
    """Native Google Gemini (google-genai) client."""

    def __init__(self, endpoint: ModelEndpoint) -> None:
        self.endpoint = endpoint
        self.model_id = endpoint.id
        self.max_context = endpoint.max_context
        client_kwargs: dict[str, Any] = {"api_key": resolve_api_key(endpoint)}
        http_options: dict[str, Any] = {"timeout": int(endpoint.timeout_s * 1000)}
        if endpoint.base_url:
            http_options["base_url"] = endpoint.base_url
        client_kwargs["http_options"] = http_options
        self._client = genai.Client(**client_kwargs)

    def _request(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig,
        tools: Sequence[ToolDefinition] | None,
        tool_choice: ToolChoice | None,
        extra: Mapping[str, Any] | None,
    ) -> tuple[list[genai_types.Content], genai_types.GenerateContentConfig]:
        reject_openrouter_request_fields(
            extra,
            provider=self.endpoint.provider,
            model_id=self.model_id,
        )
        system_text, contents = _google_contents(messages)
        config_kwargs: dict[str, Any] = {
            "temperature": sampling.temperature,
            "top_p": sampling.top_p,
            "max_output_tokens": sampling.max_tokens,
        }
        if sampling.seed is not None:
            config_kwargs["seed"] = sampling.seed
        if system_text:
            config_kwargs["system_instruction"] = system_text
        if tools:
            config_kwargs["tools"] = _google_tools(tools)
        if tool_choice is not None:
            config_kwargs["tool_config"] = _google_tool_config(tool_choice)
        if extra:
            config_kwargs.update(extra)
        return contents, genai_types.GenerateContentConfig(**config_kwargs)

    async def chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[ToolDefinition] | None = None,
        tool_choice: ToolChoice | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> ModelResponse:
        contents, config = self._request(
            messages, sampling or SamplingConfig(), tools, tool_choice, extra
        )
        started = time.perf_counter()
        response = await _call_with_retries(
            lambda: self._client.aio.models.generate_content(
                model=self.endpoint.model,
                contents=contents,
                config=config,
            ),
            provider=self.endpoint.provider,
            model_id=self.model_id,
        )
        latency_s = time.perf_counter() - started

        text_parts, thought_parts, tool_calls, finish_reason = _google_extract(response)
        usage = Usage()
        usage_metadata = getattr(response, "usage_metadata", None)
        if usage_metadata is not None:
            usage = Usage(
                prompt_tokens=usage_metadata.prompt_token_count,
                completion_tokens=usage_metadata.candidates_token_count,
                total_tokens=usage_metadata.total_token_count,
            )
        return ModelResponse(
            model_id=self.model_id,
            content="".join(text_parts),
            finish_reason=finish_reason,
            usage=usage,
            latency_s=latency_s,
            tool_calls=tool_calls,
            raw=response.model_dump(mode="json"),
            reasoning="".join(thought_parts) or None,
        )

    async def stream_chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[ToolDefinition] | None = None,
        tool_choice: ToolChoice | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> AsyncIterator[StreamChunk]:
        contents, config = self._request(
            messages, sampling or SamplingConfig(), tools, tool_choice, extra
        )
        stream = await _call_with_retries(
            lambda: self._client.aio.models.generate_content_stream(
                model=self.endpoint.model,
                contents=contents,
                config=config,
            ),
            provider=self.endpoint.provider,
            model_id=self.model_id,
        )
        async for chunk in stream:
            text_parts, thought_parts, tool_calls, finish_reason = _google_extract(chunk)
            usage = None
            usage_metadata = getattr(chunk, "usage_metadata", None)
            if usage_metadata is not None:
                usage = Usage(
                    prompt_tokens=usage_metadata.prompt_token_count,
                    completion_tokens=usage_metadata.candidates_token_count,
                    total_tokens=usage_metadata.total_token_count,
                )
            yield StreamChunk(
                delta="".join(text_parts),
                tool_call_delta=tool_calls[0] if tool_calls else None,
                finish_reason=finish_reason,
                usage=usage,
                model_reasoning_delta="".join(thought_parts) or None,
            )
            # Gemini emits complete function calls; a chunk with several
            # parallel calls must surface all of them, not just the first.
            for call in tool_calls[1:]:
                yield StreamChunk(tool_call_delta=call)

    async def aclose(self) -> None:
        # google-genai manages its own transport and exposes no stable public
        # close hook across versions; close the underlying async httpx client if
        # one is reachable, otherwise rely on GC. Best-effort by design.
        api_client = getattr(self._client, "_api_client", None)
        httpx_client = getattr(api_client, "_async_httpx_client", None)
        aclose = getattr(httpx_client, "aclose", None)
        if aclose is not None:
            with contextlib.suppress(Exception):
                await aclose()

