from __future__ import annotations

import contextlib
import json
import time
from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Any, Protocol, assert_never, runtime_checkable

from anthropic import AsyncAnthropic
from google import genai
from google.genai import types as genai_types
from openai import AsyncOpenAI

from fusionkit_core.config import FusionConfig, ModelEndpoint, SamplingConfig
from fusionkit_core.credentials import resolve_credential
from fusionkit_core.providers import resolve_api_key
from fusionkit_core.types import ChatMessage, ModelResponse, StreamChunk, ToolCall, Usage

ToolDefinition = Mapping[str, Any]
ToolChoice = str | Mapping[str, Any]

# Default base URLs for subscription providers when the endpoint omits one.
ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com"
CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"

# The codex Responses backend rejects requests without `instructions`; this is
# used when the conversation carries no system message.
CODEX_DEFAULT_INSTRUCTIONS = "You are a helpful assistant."

# Anthropic OAuth (subscription) tokens are only accepted when the request looks
# like Claude Code: the first system message must identify as the official CLI,
# and the beta header must be present.
CLAUDE_CODE_SPOOF_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude."
ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20"


@runtime_checkable
class ChatClient(Protocol):
    model_id: str

    async def chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[ToolDefinition] | None = None,
        tool_choice: ToolChoice | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> ModelResponse:
        """Generate a chat completion."""
        ...

    def stream_chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[ToolDefinition] | None = None,
        tool_choice: ToolChoice | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> AsyncIterator[StreamChunk]:
        """Stream a chat completion as incremental chunks."""
        ...

    async def aclose(self) -> None:
        """Release any underlying network resources (HTTP connection pool)."""
        ...


class OpenAICompatibleClient:
    """Client for any OpenAI Chat Completions compatible endpoint.

    Covers the ``openai``, ``openai-compatible``, ``mlx-lm`` and ``custom``
    providers, all of which speak the OpenAI Chat Completions wire format.
    """

    def __init__(self, endpoint: ModelEndpoint) -> None:
        self.endpoint = endpoint
        self.model_id = endpoint.id
        self._client = AsyncOpenAI(
            base_url=f"{endpoint.base_url}/v1",
            api_key=resolve_api_key(endpoint),
            timeout=endpoint.timeout_s,
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
        if self.endpoint.provider == "openai":
            # Modern OpenAI chat models (gpt-5.x, o-series) require
            # ``max_completion_tokens`` instead of ``max_tokens`` and only accept
            # the default temperature/top_p, so the sampling knobs are omitted to
            # stay compatible across the whole OpenAI line. Callers that target an
            # OpenAI-compatible server (vLLM, MLX, …) keep the classic params.
            payload["max_completion_tokens"] = sampling.max_tokens
        else:
            payload["temperature"] = sampling.temperature
            payload["top_p"] = sampling.top_p
            payload["max_tokens"] = sampling.max_tokens
            if sampling.seed is not None:
                payload["seed"] = sampling.seed
        if tools:
            payload["tools"] = _openai_tools(tools)
        if tool_choice is not None:
            payload["tool_choice"] = _openai_tool_choice(tool_choice)
        if extra:
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
        payload = self._payload(messages, sampling or SamplingConfig(), tools, tool_choice, extra)
        started = time.perf_counter()
        response = await self._client.chat.completions.create(**payload)
        latency_s = time.perf_counter() - started
        choice = response.choices[0]
        usage = Usage()
        if response.usage is not None:
            usage = Usage(
                prompt_tokens=response.usage.prompt_tokens,
                completion_tokens=response.usage.completion_tokens,
                total_tokens=response.usage.total_tokens,
            )
        return ModelResponse(
            model_id=self.model_id,
            content=choice.message.content or "",
            finish_reason=choice.finish_reason,
            usage=usage,
            latency_s=latency_s,
            tool_calls=_openai_tool_calls(getattr(choice.message, "tool_calls", None)),
            raw=response.model_dump(mode="json"),
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
        stream = await self._client.chat.completions.create(**payload)
        async for event in stream:
            usage = None
            if getattr(event, "usage", None) is not None:
                usage = Usage(
                    prompt_tokens=event.usage.prompt_tokens,
                    completion_tokens=event.usage.completion_tokens,
                    total_tokens=event.usage.total_tokens,
                )
            if not event.choices:
                if usage is not None:
                    yield StreamChunk(usage=usage)
                continue
            choice = event.choices[0]
            delta = choice.delta
            yield StreamChunk(
                delta=delta.content or "",
                tool_call_delta=_openai_stream_tool_call(getattr(delta, "tool_calls", None)),
                finish_reason=choice.finish_reason,
                usage=usage,
            )

    async def aclose(self) -> None:
        await self._client.close()


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
            )
        else:
            self._client = AsyncAnthropic(
                base_url=endpoint.base_url,
                api_key=resolve_api_key(endpoint),
                timeout=endpoint.timeout_s,
            )

    def _kwargs(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig,
        tools: Sequence[ToolDefinition] | None,
        tool_choice: ToolChoice | None,
        extra: Mapping[str, Any] | None,
    ) -> dict[str, Any]:
        system_text, conversation = _anthropic_messages(messages)
        if self._auth_mode == "claude-code":
            system_text = (
                f"{CLAUDE_CODE_SPOOF_SYSTEM}\n\n{system_text}"
                if system_text
                else CLAUDE_CODE_SPOOF_SYSTEM
            )
        # Sampling knobs are omitted by default: newer Anthropic models (e.g.
        # claude-opus-4-8) reject `temperature` outright ("deprecated for this
        # model"), and several reject setting both temperature and top_p. The
        # model default is used; callers that need explicit sampling can pass
        # `temperature`/`top_p` via ``extra``.
        kwargs: dict[str, Any] = {
            "model": self.endpoint.model,
            "messages": conversation,
            "max_tokens": sampling.max_tokens,
        }
        if system_text:
            kwargs["system"] = system_text
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
        message = await self._client.messages.create(**kwargs)
        latency_s = time.perf_counter() - started

        text_parts: list[str] = []
        tool_calls: list[ToolCall] = []
        for block in message.content:
            if getattr(block, "type", None) == "text":
                text_parts.append(block.text)
            elif getattr(block, "type", None) == "tool_use":
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
        stream = await self._client.messages.create(**kwargs)
        async for event in stream:
            event_type = getattr(event, "type", None)
            if event_type == "content_block_delta":
                delta = event.delta
                if getattr(delta, "type", None) == "text_delta":
                    yield StreamChunk(delta=delta.text)
            elif event_type == "message_delta":
                finish_reason = getattr(event.delta, "stop_reason", None)
                usage = None
                if getattr(event, "usage", None) is not None:
                    usage = Usage(completion_tokens=event.usage.output_tokens)
                yield StreamChunk(finish_reason=finish_reason, usage=usage)

    async def aclose(self) -> None:
        await self._client.close()


class CodexResponsesClient:
    """Codex (ChatGPT subscription) client over the private Responses API.

    Codex-family models are served only by the stream-only Responses endpoint at
    ``https://chatgpt.com/backend-api/codex/responses`` (not Chat Completions),
    authenticated with the local Codex OAuth token (``Authorization: Bearer`` +
    ``chatgpt-account-id``). The token is resolved per request. Tool calls over
    the Responses API are out of scope: this client returns text output and
    aggregates the stream for the non-streaming ``chat`` path.
    """

    def __init__(self, endpoint: ModelEndpoint) -> None:
        self.endpoint = endpoint
        self.model_id = endpoint.id
        self._client = AsyncOpenAI(
            base_url=endpoint.base_url or CODEX_BASE_URL,
            api_key="placeholder-oauth-token",
            default_headers={"OpenAI-Beta": "responses=v1", "originator": "fusionkit"},
            timeout=endpoint.timeout_s,
        )

    def _request_kwargs(
        self,
        messages: Sequence[ChatMessage],
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
        del tools, tool_choice, sampling
        started = time.perf_counter()
        text_parts: list[str] = []
        usage = Usage()
        finish_reason: str | None = None
        async for chunk in self._stream(messages, extra):
            text_parts.append(chunk.delta)
            if chunk.usage is not None:
                usage = chunk.usage
            if chunk.finish_reason is not None:
                finish_reason = chunk.finish_reason
        return ModelResponse(
            model_id=self.model_id,
            content="".join(text_parts),
            finish_reason=finish_reason or "stop",
            usage=usage,
            latency_s=time.perf_counter() - started,
        )

    async def stream_chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[ToolDefinition] | None = None,
        tool_choice: ToolChoice | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> AsyncIterator[StreamChunk]:
        del tools, tool_choice, sampling
        async for chunk in self._stream(messages, extra):
            yield chunk

    async def _stream(
        self,
        messages: Sequence[ChatMessage],
        extra: Mapping[str, Any] | None,
    ) -> AsyncIterator[StreamChunk]:
        kwargs = self._request_kwargs(messages, extra)
        stream = await self._client.responses.create(**kwargs)
        async for event in stream:
            event_type = getattr(event, "type", None)
            if event_type == "response.output_text.delta":
                yield StreamChunk(delta=getattr(event, "delta", "") or "")
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


class GoogleModelClient:
    """Native Google Gemini (google-genai) client."""

    def __init__(self, endpoint: ModelEndpoint) -> None:
        self.endpoint = endpoint
        self.model_id = endpoint.id
        self._client = genai.Client(api_key=resolve_api_key(endpoint))

    def _request(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig,
        tools: Sequence[ToolDefinition] | None,
        tool_choice: ToolChoice | None,
        extra: Mapping[str, Any] | None,
    ) -> tuple[list[genai_types.Content], genai_types.GenerateContentConfig]:
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
        response = await self._client.aio.models.generate_content(
            model=self.endpoint.model,
            contents=contents,
            config=config,
        )
        latency_s = time.perf_counter() - started

        text_parts, tool_calls, finish_reason = _google_extract(response)
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
        stream = await self._client.aio.models.generate_content_stream(
            model=self.endpoint.model,
            contents=contents,
            config=config,
        )
        async for chunk in stream:
            text_parts, tool_calls, finish_reason = _google_extract(chunk)
            tool_call_delta = tool_calls[0] if tool_calls else None
            yield StreamChunk(
                delta="".join(text_parts),
                tool_call_delta=tool_call_delta,
                finish_reason=finish_reason,
            )

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


class FakeModelClient:
    def __init__(self, model_id: str, responses: Sequence[str] | None = None) -> None:
        self.model_id = model_id
        self._responses = list(responses or [])
        self._calls = 0

    def _next_content(self, messages: Sequence[ChatMessage], sampling: SamplingConfig) -> str:
        if self._responses:
            content = self._responses[self._calls % len(self._responses)]
        else:
            user_text = " ".join(
                message.content for message in messages if message.role == "user"
            )
            content = (
                f"{self.model_id} response {self._calls + 1} "
                f"at temperature {sampling.temperature}: {user_text}"
            )
        self._calls += 1
        return content

    async def chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[ToolDefinition] | None = None,
        tool_choice: ToolChoice | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> ModelResponse:
        del tools, tool_choice, extra
        started = time.perf_counter()
        sampling = sampling or SamplingConfig()
        content = self._next_content(messages, sampling)
        return ModelResponse(
            model_id=self.model_id,
            content=content,
            latency_s=time.perf_counter() - started,
            usage=Usage(prompt_tokens=0, completion_tokens=len(content.split())),
        )

    async def stream_chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[ToolDefinition] | None = None,
        tool_choice: ToolChoice | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> AsyncIterator[StreamChunk]:
        del tools, tool_choice, extra
        content = self._next_content(messages, sampling or SamplingConfig())
        for token in content.split():
            yield StreamChunk(delta=f"{token} ")
        yield StreamChunk(
            finish_reason="stop",
            usage=Usage(prompt_tokens=0, completion_tokens=len(content.split())),
        )

    async def aclose(self) -> None:
        return None


# Backwards-compatible alias: the original name used before native cloud
# clients were introduced.
LocalModelClient = OpenAICompatibleClient


def build_client(endpoint: ModelEndpoint) -> ChatClient:
    """Construct the right :class:`ChatClient` for an endpoint's provider."""
    match endpoint.provider:
        case "openai" | "openai-compatible" | "mlx-lm" | "custom":
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


def _openai_messages(messages: Sequence[ChatMessage]) -> list[dict[str, Any]]:
    serialized: list[dict[str, Any]] = []
    for message in messages:
        entry: dict[str, Any] = {"role": message.role, "content": message.content}
        if message.name is not None:
            entry["name"] = message.name
        if message.tool_call_id is not None:
            entry["tool_call_id"] = message.tool_call_id
        if message.tool_calls:
            entry["tool_calls"] = [
                {
                    "id": call.id,
                    "type": "function",
                    "function": {"name": call.name, "arguments": call.arguments},
                }
                for call in message.tool_calls
            ]
        serialized.append(entry)
    return serialized


def _openai_tools(tools: Sequence[ToolDefinition]) -> list[dict[str, Any]]:
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


def _openai_tool_choice(tool_choice: ToolChoice) -> Any:
    if isinstance(tool_choice, str):
        return tool_choice
    return {"type": "function", "function": {"name": tool_choice["name"]}}


def _openai_tool_calls(tool_calls: Any) -> list[ToolCall]:
    if not tool_calls:
        return []
    parsed: list[ToolCall] = []
    for call in tool_calls:
        function = call.function
        parsed.append(
            ToolCall(
                id=call.id or "",
                name=function.name or "",
                arguments=function.arguments or "{}",
            )
        )
    return parsed


def _openai_stream_tool_call(tool_calls: Any) -> ToolCall | None:
    if not tool_calls:
        return None
    call = tool_calls[0]
    function = getattr(call, "function", None)
    return ToolCall(
        id=getattr(call, "id", None) or "",
        name=(getattr(function, "name", None) or "") if function else "",
        arguments=(getattr(function, "arguments", None) or "") if function else "",
    )


def _anthropic_messages(
    messages: Sequence[ChatMessage],
) -> tuple[str, list[dict[str, Any]]]:
    system_parts: list[str] = []
    conversation: list[dict[str, Any]] = []
    for message in messages:
        if message.role == "system":
            system_parts.append(message.content)
            continue
        if message.role == "tool":
            conversation.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": message.tool_call_id or "",
                            "content": message.content,
                        }
                    ],
                }
            )
            continue
        if message.role == "assistant" and message.tool_calls:
            blocks: list[dict[str, Any]] = []
            if message.content:
                blocks.append({"type": "text", "text": message.content})
            for call in message.tool_calls:
                blocks.append(
                    {
                        "type": "tool_use",
                        "id": call.id,
                        "name": call.name,
                        "input": _loads_arguments(call.arguments),
                    }
                )
            conversation.append({"role": "assistant", "content": blocks})
            continue
        conversation.append({"role": message.role, "content": message.content})
    return "\n".join(part for part in system_parts if part), conversation


def _codex_input(messages: Sequence[ChatMessage]) -> tuple[str, list[dict[str, Any]]]:
    """Translate chat messages into Responses-API `instructions` + `input` items.

    System messages collapse into `instructions`; user/tool turns become
    `input_text` items and assistant turns become `output_text` items.
    """
    instruction_parts: list[str] = []
    items: list[dict[str, Any]] = []
    for message in messages:
        if message.role == "system":
            if message.content:
                instruction_parts.append(message.content)
            continue
        if message.role == "assistant":
            content_type = "output_text"
            role = "assistant"
        else:
            content_type = "input_text"
            role = "user"
        items.append(
            {"role": role, "content": [{"type": content_type, "text": message.content}]}
        )
    return "\n".join(instruction_parts), items


def _codex_usage(usage: Any) -> Usage | None:
    if usage is None:
        return None
    prompt_tokens = getattr(usage, "input_tokens", None)
    completion_tokens = getattr(usage, "output_tokens", None)
    total_tokens = getattr(usage, "total_tokens", None)
    if total_tokens is None and (prompt_tokens is not None or completion_tokens is not None):
        total_tokens = (prompt_tokens or 0) + (completion_tokens or 0)
    return Usage(
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        total_tokens=total_tokens,
    )


def _anthropic_tools(tools: Sequence[ToolDefinition]) -> list[dict[str, Any]]:
    return [
        {
            "name": tool["name"],
            "description": tool.get("description", ""),
            "input_schema": tool.get("parameters", {"type": "object", "properties": {}}),
        }
        for tool in tools
    ]


def _anthropic_tool_choice(tool_choice: ToolChoice) -> dict[str, Any]:
    if isinstance(tool_choice, str):
        mapping = {"auto": "auto", "required": "any", "any": "any", "none": "none"}
        return {"type": mapping.get(tool_choice, "auto")}
    return {"type": "tool", "name": tool_choice["name"]}


def _google_contents(
    messages: Sequence[ChatMessage],
) -> tuple[str, list[genai_types.Content]]:
    system_parts: list[str] = []
    contents: list[genai_types.Content] = []
    for message in messages:
        if message.role == "system":
            system_parts.append(message.content)
            continue
        if message.role == "tool":
            contents.append(
                genai_types.Content(
                    role="user",
                    parts=[
                        genai_types.Part.from_function_response(
                            name=message.name or "",
                            response={"result": message.content},
                        )
                    ],
                )
            )
            continue
        role = "model" if message.role == "assistant" else "user"
        parts: list[genai_types.Part] = []
        if message.content:
            parts.append(genai_types.Part.from_text(text=message.content))
        if message.tool_calls:
            for call in message.tool_calls:
                parts.append(
                    genai_types.Part.from_function_call(
                        name=call.name,
                        args=_loads_arguments(call.arguments),
                    )
                )
        contents.append(genai_types.Content(role=role, parts=parts))
    return "\n".join(part for part in system_parts if part), contents


def _google_tools(tools: Sequence[ToolDefinition]) -> list[genai_types.Tool]:
    declarations = [
        genai_types.FunctionDeclaration(
            name=tool["name"],
            description=tool.get("description", ""),
            parameters_json_schema=tool.get("parameters", {"type": "object", "properties": {}}),
        )
        for tool in tools
    ]
    return [genai_types.Tool(function_declarations=declarations)]


def _google_tool_config(tool_choice: ToolChoice) -> genai_types.ToolConfig:
    mode_enum = genai_types.FunctionCallingConfigMode
    if isinstance(tool_choice, str):
        mode = {
            "auto": mode_enum.AUTO,
            "required": mode_enum.ANY,
            "any": mode_enum.ANY,
            "none": mode_enum.NONE,
        }.get(tool_choice, mode_enum.AUTO)
        return genai_types.ToolConfig(
            function_calling_config=genai_types.FunctionCallingConfig(mode=mode)
        )
    return genai_types.ToolConfig(
        function_calling_config=genai_types.FunctionCallingConfig(
            mode=mode_enum.ANY,
            allowed_function_names=[tool_choice["name"]],
        )
    )


def _google_extract(response: Any) -> tuple[list[str], list[ToolCall], str | None]:
    text_parts: list[str] = []
    tool_calls: list[ToolCall] = []
    finish_reason: str | None = None
    candidates = getattr(response, "candidates", None) or []
    for candidate in candidates:
        if getattr(candidate, "finish_reason", None) is not None:
            finish_reason = str(candidate.finish_reason)
        content = getattr(candidate, "content", None)
        for part in getattr(content, "parts", None) or []:
            if getattr(part, "text", None):
                text_parts.append(part.text)
            function_call = getattr(part, "function_call", None)
            if function_call is not None:
                tool_calls.append(
                    ToolCall(
                        id=getattr(function_call, "id", None) or function_call.name,
                        name=function_call.name,
                        arguments=json.dumps(dict(function_call.args or {})),
                    )
                )
    return text_parts, tool_calls, finish_reason


def _loads_arguments(arguments: str) -> dict[str, Any]:
    try:
        loaded = json.loads(arguments or "{}")
    except json.JSONDecodeError:
        return {}
    return loaded if isinstance(loaded, dict) else {}
