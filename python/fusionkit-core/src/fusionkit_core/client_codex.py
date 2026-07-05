from __future__ import annotations

import time
from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Any

from openai import AsyncOpenAI

from fusionkit_core.client_errors import _call_with_retries
from fusionkit_core.client_types import ToolChoice, ToolDefinition
from fusionkit_core.client_wire import _codex_input, _codex_tool_choice, _codex_tools, _codex_usage
from fusionkit_core.config import ModelEndpoint, SamplingConfig
from fusionkit_core.credentials import resolve_credential
from fusionkit_core.registry import (
    CODEX_BASE_URL,
    CODEX_DEFAULT_HEADERS,
    CODEX_DEFAULT_INSTRUCTIONS,
)
from fusionkit_core.types import ChatMessage, ModelResponse, StreamChunk, ToolCall, Usage


class CodexResponsesClient:
    """Codex (ChatGPT subscription) client over the private Responses API.

    Codex-family models are served only by the stream-only Responses endpoint at
    ``https://chatgpt.com/backend-api/codex/responses`` (not Chat Completions),
    authenticated with the local Codex OAuth token (``Authorization: Bearer`` +
    ``chatgpt-account-id``). The token is resolved per request.

    Tool calling is supported via the Responses API's native function-tool
    protocol: tools are forwarded as flat function definitions, assistant tool
    calls and their results round-trip as ``function_call`` / ``function_call_output``
    input items, and streamed function-call events are aggregated into
    :class:`ToolCall` results. This lets the codex model both drive the agent
    harness loop and act as the trajectory-step judge.
    """

    def __init__(self, endpoint: ModelEndpoint) -> None:
        self.endpoint = endpoint
        self.model_id = endpoint.id
        self.max_context = endpoint.max_context
        self._client = AsyncOpenAI(
            base_url=endpoint.base_url or CODEX_BASE_URL,
            api_key="placeholder-oauth-token",
            default_headers=CODEX_DEFAULT_HEADERS,
            timeout=endpoint.timeout_s,
        )

    def _request_kwargs(
        self,
        messages: Sequence[ChatMessage],
        tools: Sequence[ToolDefinition] | None,
        tool_choice: ToolChoice | None,
        extra: Mapping[str, Any] | None,
    ) -> dict[str, Any]:
        instructions, input_items = _codex_input(messages)
        credential = resolve_credential(self.endpoint)
        # Capital "Authorization" matches the SDK's constructor auth header key so
        # the per-request token overrides the placeholder (see AnthropicModelClient).
        extra_headers = {"Authorization": f"Bearer {credential.token}"}
        if credential.account_id:
            extra_headers["chatgpt-account-id"] = credential.account_id
        # The codex backend rejects `max_output_tokens` (the subscription manages
        # its own limits), so sampling knobs are intentionally not forwarded.
        kwargs: dict[str, Any] = {
            "model": self.endpoint.model,
            "instructions": instructions or CODEX_DEFAULT_INSTRUCTIONS,
            "input": input_items,
            "stream": True,
            # The codex backend is stateless and rejects requests unless storage
            # is explicitly disabled.
            "store": False,
            "extra_headers": extra_headers,
        }
        if tools:
            kwargs["tools"] = _codex_tools(tools)
        if tool_choice is not None:
            kwargs["tool_choice"] = _codex_tool_choice(tool_choice)
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
        del sampling
        started = time.perf_counter()
        text_parts: list[str] = []
        reasoning_parts: list[str] = []
        usage = Usage()
        finish_reason: str | None = None
        # Aggregate streamed function-call fragments by call id, preserving the
        # order the model emitted them so parallel tool calls round-trip intact.
        tool_fragments: dict[str, dict[str, str]] = {}
        tool_order: list[str] = []
        async for chunk in self._stream(messages, tools, tool_choice, extra):
            text_parts.append(chunk.delta)
            if chunk.model_reasoning_delta:
                reasoning_parts.append(chunk.model_reasoning_delta)
            if chunk.tool_call_delta is not None:
                fragment = tool_fragments.get(chunk.tool_call_delta.id)
                if fragment is None:
                    fragment = {"name": "", "arguments": ""}
                    tool_fragments[chunk.tool_call_delta.id] = fragment
                    tool_order.append(chunk.tool_call_delta.id)
                if chunk.tool_call_delta.name:
                    fragment["name"] = chunk.tool_call_delta.name
                fragment["arguments"] += chunk.tool_call_delta.arguments
            if chunk.usage is not None:
                usage = chunk.usage
            if chunk.finish_reason is not None:
                finish_reason = chunk.finish_reason
        tool_calls = [
            ToolCall(
                id=call_id,
                name=tool_fragments[call_id]["name"],
                arguments=tool_fragments[call_id]["arguments"] or "{}",
            )
            for call_id in tool_order
        ]
        return ModelResponse(
            model_id=self.model_id,
            content="".join(text_parts),
            finish_reason=finish_reason or "stop",
            usage=usage,
            latency_s=time.perf_counter() - started,
            tool_calls=tool_calls,
            reasoning="".join(reasoning_parts) or None,
        )

    async def stream_chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[ToolDefinition] | None = None,
        tool_choice: ToolChoice | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> AsyncIterator[StreamChunk]:
        del sampling
        async for chunk in self._stream(messages, tools, tool_choice, extra):
            yield chunk

    async def _stream(
        self,
        messages: Sequence[ChatMessage],
        tools: Sequence[ToolDefinition] | None,
        tool_choice: ToolChoice | None,
        extra: Mapping[str, Any] | None,
    ) -> AsyncIterator[StreamChunk]:
        kwargs = self._request_kwargs(messages, tools, tool_choice, extra)
        stream = await _call_with_retries(
            lambda: self._client.responses.create(**kwargs),
            provider=self.endpoint.provider,
            model_id=self.model_id,
        )
        # Argument deltas key off the output item id, but tool results must pair
        # back via the function `call_id`; map one to the other as items open.
        call_id_by_item: dict[str, str] = {}
        reasoning_seen = False
        pending_reasoning_break = False
        async for event in stream:
            event_type = getattr(event, "type", None)
            if event_type == "response.output_text.delta":
                yield StreamChunk(delta=getattr(event, "delta", "") or "")
            elif event_type in (
                "response.reasoning_summary_text.delta",
                "response.reasoning_text.delta",
            ):
                # The model's own reasoning tokens (summary parts or raw
                # reasoning text). Out-of-band: never part of the answer.
                reasoning_delta = getattr(event, "delta", "") or ""
                if reasoning_delta:
                    if pending_reasoning_break:
                        pending_reasoning_break = False
                        reasoning_delta = "\n\n" + reasoning_delta
                    reasoning_seen = True
                    yield StreamChunk(model_reasoning_delta=reasoning_delta)
            elif event_type == "response.reasoning_summary_part.added":
                # Summary parts are distinct thoughts; keep a blank line between
                # them so folded text does not run parts together.
                pending_reasoning_break = reasoning_seen
            elif event_type == "response.output_item.added":
                item = getattr(event, "item", None)
                if getattr(item, "type", None) == "function_call":
                    call_id = getattr(item, "call_id", None) or ""
                    item_id = getattr(item, "id", None)
                    if item_id is not None:
                        call_id_by_item[item_id] = call_id
                    # Open the call with its name; arguments stream in separately.
                    yield StreamChunk(
                        tool_call_delta=ToolCall(
                            id=call_id, name=getattr(item, "name", "") or "", arguments=""
                        )
                    )
            elif event_type == "response.function_call_arguments.delta":
                item_id = str(getattr(event, "item_id", "") or "")
                call_id = call_id_by_item.get(item_id, item_id)
                yield StreamChunk(
                    tool_call_delta=ToolCall(
                        id=call_id, name="", arguments=getattr(event, "delta", "") or ""
                    )
                )
            elif event_type in ("response.completed", "response.incomplete"):
                response = getattr(event, "response", None)
                usage = _codex_usage(getattr(response, "usage", None))
                finish_reason = "stop" if event_type == "response.completed" else "length"
                yield StreamChunk(finish_reason=finish_reason, usage=usage)
            elif event_type == "response.failed":
                response = getattr(event, "response", None)
                error = getattr(response, "error", None)
                message = getattr(error, "message", None) or "Codex response failed"
                raise RuntimeError(message)

    async def aclose(self) -> None:
        await self._client.close()

