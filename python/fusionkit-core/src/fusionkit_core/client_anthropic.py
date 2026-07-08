from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Any

from anthropic import AsyncAnthropic

from fusionkit_core.client_errors import _call_with_retries
from fusionkit_core.client_types import ToolChoice, ToolDefinition
from fusionkit_core.client_wire import _anthropic_messages, _anthropic_tool_choice, _anthropic_tools
from fusionkit_core.config import ModelEndpoint, SamplingConfig
from fusionkit_core.credentials import resolve_credential
from fusionkit_core.providers import resolve_api_key
from fusionkit_core.registry import (
    ANTHROPIC_DEFAULT_BASE_URL,
    ANTHROPIC_OAUTH_BETA,
    CLAUDE_CODE_SPOOF_SYSTEM,
)
from fusionkit_core.types import ChatMessage, ModelResponse, StreamChunk, ToolCall, Usage


class AnthropicModelClient:
    """Native Anthropic Messages API client.

    Supports two auth modes (see ``endpoint.auth.mode``): the default ``api_key``
    path (``x-api-key``) and the ``claude-code`` subscription path, which reuses
    the local Claude Code OAuth token (``Authorization: Bearer`` + the OAuth beta
    header, with the Claude Code identity spoof prepended as the first system
    message). The subscription token is resolved per request so a long-running
    server stays valid as the CLI refreshes it.
    """

    def __init__(self, endpoint: ModelEndpoint) -> None:
        self.endpoint = endpoint
        self.model_id = endpoint.id
        self.max_context = endpoint.max_context
        self._auth_mode = endpoint.auth.mode
        if self._auth_mode == "claude-code":
            # `auth_token=` makes the SDK send `Authorization: Bearer` and never
            # `x-api-key` (sending both fails). The actual token is overridden per
            # request via `extra_headers` in `_kwargs`.
            self._client = AsyncAnthropic(
                base_url=endpoint.base_url or ANTHROPIC_DEFAULT_BASE_URL,
                auth_token="placeholder-oauth-token",
                default_headers={"anthropic-beta": ANTHROPIC_OAUTH_BETA},
                timeout=endpoint.timeout_s,
                max_retries=0,
            )
        else:
            self._client = AsyncAnthropic(
                base_url=endpoint.base_url,
                api_key=resolve_api_key(endpoint),
                timeout=endpoint.timeout_s,
                max_retries=0,
            )

    def _system_param(self, system_text: str) -> str | list[dict[str, Any]] | None:
        """Build the Anthropic ``system`` parameter.

        For the default ``api_key`` path a plain string is fine. For the
        ``claude-code`` (OAuth subscription) path, Anthropic routes the request
        into the high-capacity Claude Code rate-limit lane only when the FIRST
        ``system`` block is *exactly* the Claude Code identity string. A single
        concatenated block (identity + the real system prompt merged together)
        is not recognized and falls back to the overage lane, which returns a
        persistent ``429 rate_limit_error`` (no ``retry-after``) for Sonnet/Opus.
        So the identity must be its own discrete first block.
        """
        if self._auth_mode != "claude-code":
            return system_text or None
        blocks: list[dict[str, Any]] = [
            {"type": "text", "text": CLAUDE_CODE_SPOOF_SYSTEM}
        ]
        if system_text:
            blocks.append({"type": "text", "text": system_text})
        return blocks

    def _kwargs(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig,
        tools: Sequence[ToolDefinition] | None,
        tool_choice: ToolChoice | None,
        extra: Mapping[str, Any] | None,
    ) -> dict[str, Any]:
        system_text, conversation = _anthropic_messages(messages)
        # Registry providerRequestShapes marks Anthropic sampling as omitted:
        # newer Anthropic models reject explicit temperature/top_p, while callers
        # that need them can still pass provider-specific values via ``extra``.
        kwargs: dict[str, Any] = {
            "model": self.endpoint.model,
            "messages": conversation,
            "max_tokens": sampling.max_tokens,
        }
        system = self._system_param(system_text)
        if system is not None:
            kwargs["system"] = system
        if tools:
            kwargs["tools"] = _anthropic_tools(tools)
        if tool_choice is not None:
            kwargs["tool_choice"] = _anthropic_tool_choice(tool_choice)
        if self._auth_mode == "claude-code":
            credential = resolve_credential(self.endpoint)
            # Capital "Authorization" matches the key the SDK sets from
            # `auth_token=`; the SDK merges headers with a plain dict spread, so a
            # differently-cased key would not override the constructor placeholder.
            kwargs["extra_headers"] = {"Authorization": f"Bearer {credential.token}"}
        if extra:
            kwargs.update(extra)
        return kwargs

    async def chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[ToolDefinition] | None = None,
        tool_choice: ToolChoice | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> ModelResponse:
        kwargs = self._kwargs(messages, sampling or SamplingConfig(), tools, tool_choice, extra)
        started = time.perf_counter()
        message = await _call_with_retries(
            lambda: self._client.messages.create(**kwargs),
            provider=self.endpoint.provider,
            model_id=self.model_id,
        )
        latency_s = time.perf_counter() - started

        text_parts: list[str] = []
        thinking_parts: list[str] = []
        tool_calls: list[ToolCall] = []
        for block in message.content:
            block_type = getattr(block, "type", None)
            if block_type == "text":
                text_parts.append(block.text)
            elif block_type == "thinking":
                # Extended-thinking block (present only when the caller enabled
                # thinking). Redacted blocks carry no readable text and are skipped.
                thinking = getattr(block, "thinking", None)
                if isinstance(thinking, str) and thinking:
                    thinking_parts.append(thinking)
            elif block_type == "tool_use":
                tool_calls.append(
                    ToolCall(id=block.id, name=block.name, arguments=json.dumps(block.input))
                )

        usage = Usage()
        if message.usage is not None:
            prompt_tokens = message.usage.input_tokens
            completion_tokens = message.usage.output_tokens
            usage = Usage(
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                total_tokens=(prompt_tokens or 0) + (completion_tokens or 0),
            )
        return ModelResponse(
            model_id=self.model_id,
            content="".join(text_parts),
            finish_reason=message.stop_reason,
            usage=usage,
            latency_s=latency_s,
            tool_calls=tool_calls,
            raw=message.model_dump(mode="json"),
            reasoning="".join(thinking_parts) or None,
        )

    async def stream_chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[ToolDefinition] | None = None,
        tool_choice: ToolChoice | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> AsyncIterator[StreamChunk]:
        kwargs = self._kwargs(messages, sampling or SamplingConfig(), tools, tool_choice, extra)
        kwargs["stream"] = True
        stream = await _call_with_retries(
            lambda: self._client.messages.create(**kwargs),
            provider=self.endpoint.provider,
            model_id=self.model_id,
        )
        # Anthropic splits token usage across two events: ``message_start`` carries
        # ``input_tokens`` (the prompt cost) while ``message_delta`` carries the
        # final ``output_tokens``. Capture the input count up front so the usage
        # emitted on the terminal chunk includes ``prompt_tokens`` too — otherwise
        # a fused turn metered off the synthesizer step (Node gateway) reads cost
        # with completion tokens only and under-reports it.
        prompt_tokens: int | None = None
        # Anthropic streams a tool call as a ``content_block_start`` (carrying the
        # block id + name) followed by ``input_json_delta`` fragments that only
        # reference the block by its content index. Map index -> (id, name) so the
        # argument fragments can be re-attached to the right call, mirroring the
        # non-stream tool_use mapping above.
        tool_use_blocks: dict[int, tuple[str, str]] = {}
        async for event in stream:
            event_type = getattr(event, "type", None)
            if event_type == "message_start":
                start_usage = getattr(getattr(event, "message", None), "usage", None)
                if start_usage is not None:
                    prompt_tokens = getattr(start_usage, "input_tokens", None)
            elif event_type == "content_block_start":
                block = getattr(event, "content_block", None)
                if getattr(block, "type", None) == "tool_use":
                    index = getattr(event, "index", None)
                    block_id = getattr(block, "id", "") or ""
                    block_name = getattr(block, "name", "") or ""
                    if isinstance(index, int):
                        tool_use_blocks[index] = (block_id, block_name)
                    # Open the call with an empty-argument fragment so the id/name
                    # are captured even if no input_json_delta follows (a tool with
                    # no arguments).
                    yield StreamChunk(
                        tool_call_delta=ToolCall(
                            id=block_id, name=block_name, arguments=""
                        )
                    )
            elif event_type == "content_block_delta":
                delta = event.delta
                delta_type = getattr(delta, "type", None)
                if delta_type == "text_delta":
                    yield StreamChunk(delta=delta.text)
                elif delta_type == "thinking_delta":
                    # Extended-thinking tokens: out-of-band reasoning, never
                    # part of the answer text.
                    thinking = getattr(delta, "thinking", None)
                    if isinstance(thinking, str) and thinking:
                        yield StreamChunk(model_reasoning_delta=thinking)
                elif delta_type == "input_json_delta":
                    # Streamed tool-call arguments: JSON text arriving in fragments.
                    partial = getattr(delta, "partial_json", None)
                    if isinstance(partial, str) and partial:
                        index = getattr(event, "index", None)
                        block_id, block_name = tool_use_blocks.get(
                            index if isinstance(index, int) else -1, ("", "")
                        )
                        yield StreamChunk(
                            tool_call_delta=ToolCall(
                                id=block_id, name=block_name, arguments=partial
                            )
                        )
            elif event_type == "message_delta":
                finish_reason = getattr(event.delta, "stop_reason", None)
                usage = None
                if getattr(event, "usage", None) is not None:
                    completion_tokens = getattr(event.usage, "output_tokens", None)
                    usage = Usage(
                        prompt_tokens=prompt_tokens,
                        completion_tokens=completion_tokens,
                        total_tokens=(prompt_tokens or 0) + (completion_tokens or 0),
                    )
                yield StreamChunk(finish_reason=finish_reason, usage=usage)

    async def aclose(self) -> None:
        await self._client.close()

