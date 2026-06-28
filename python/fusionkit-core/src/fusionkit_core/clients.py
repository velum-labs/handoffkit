from __future__ import annotations

import asyncio
import contextlib
import json
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping, Sequence
from typing import Any, Literal, Protocol, TypeVar, assert_never, runtime_checkable

from anthropic import AsyncAnthropic
from google import genai
from google.genai import types as genai_types
from openai import AsyncOpenAI

from fusionkit_core.config import FusionConfig, ModelEndpoint, ProviderKind, SamplingConfig
from fusionkit_core.credentials import resolve_credential
from fusionkit_core.providers import resolve_api_key
from fusionkit_core.types import ChatMessage, ModelResponse, StreamChunk, ToolCall, Usage

ToolDefinition = Mapping[str, Any]
ToolChoice = str | Mapping[str, Any]

# --- egress error taxonomy --------------------------------------------------
#
# Every provider failure is normalized into one of these categories so a caller
# (the panel producer here, the rate-limit failover layer in WS5) can branch on
# the *meaning* of a failure without re-parsing provider-specific error bodies:
#
#   transient        retry may succeed: HTTP 429 rate limits, 5xx, Anthropic
#                    ``overloaded_error`` (529), timeouts. Honors ``Retry-After``.
#   quota_exhausted  the account is out of money/quota: ``insufficient_quota``,
#                    billing/credit errors. Retrying the same key will not help;
#                    a failover layer should switch provider/key.
#   auth_permanent   the request can never succeed as-is: 401/403, invalid API
#                    key, ``model_not_found``. Do not retry, do not failover blind.
#   unknown          could not be classified; treated as non-retryable.
ProviderErrorCategory = Literal["transient", "quota_exhausted", "auth_permanent", "unknown"]

# Bounded exponential backoff defaults for ``transient`` failures only.
DEFAULT_RETRY_MAX_ATTEMPTS = 3
DEFAULT_RETRY_BASE_DELAY_S = 0.5
DEFAULT_RETRY_MAX_DELAY_S = 8.0

_T = TypeVar("_T")

_QUOTA_MARKERS = (
    "insufficient_quota",
    "insufficient quota",
    "exceeded your current quota",
    "billing_hard_limit_reached",
    "billing",
    "credit balance",
    "out of credits",
    "payment required",
    "quota exceeded",
)
_AUTH_MARKERS = (
    "invalid api key",
    "invalid_api_key",
    "invalid x-api-key",
    "authentication_error",
    "permission_error",
    "permission denied",
    "permission_denied",
    "model_not_found",
    "model not found",
    "does not exist",
    "no such model",
    "unauthorized",
)
_TRANSIENT_MARKERS = (
    "overloaded",
    "rate_limit",
    "rate limit",
    "ratelimit",
    "try again",
    "timeout",
    "timed out",
    "temporarily unavailable",
    "service unavailable",
    "service_unavailable",
)


class ProviderCallError(Exception):
    """A provider failure classified into a reusable :data:`ProviderErrorCategory`.

    The ``category`` is computed once at the egress boundary so downstream code
    (graceful panel degradation here; the rate-limit/credit failover layer in
    WS5) can branch on it directly. ``retry_after`` carries the parsed
    ``Retry-After`` (seconds) when the provider supplied one.
    """

    def __init__(
        self,
        message: str,
        *,
        category: ProviderErrorCategory,
        provider: ProviderKind | str,
        status_code: int | None = None,
        retry_after: float | None = None,
        model_id: str | None = None,
        original: BaseException | None = None,
    ) -> None:
        super().__init__(message)
        self.category: ProviderErrorCategory = category
        self.provider = provider
        self.status_code = status_code
        self.retry_after = retry_after
        self.model_id = model_id
        self.original = original

    @property
    def retryable(self) -> bool:
        return self.category == "transient"


def _status_code(exc: BaseException) -> int | None:
    # OpenAI/Anthropic SDK errors expose ``status_code``; google-genai's APIError
    # exposes an int ``code``; some wrap an httpx ``response``.
    value = getattr(exc, "status_code", None)
    if isinstance(value, int):
        return value
    code = getattr(exc, "code", None)
    if isinstance(code, int):
        return code
    status = getattr(getattr(exc, "response", None), "status_code", None)
    return status if isinstance(status, int) else None


def _retry_after(exc: BaseException) -> float | None:
    headers = getattr(getattr(exc, "response", None), "headers", None)
    getter = getattr(headers, "get", None)
    if callable(getter):
        raw = getter("retry-after") or getter("Retry-After")
        if raw is not None:
            try:
                return float(str(raw))
            except (TypeError, ValueError):
                return None
    direct = getattr(exc, "retry_after", None)
    if isinstance(direct, int | float):
        return float(direct)
    return None


def _error_blob(exc: BaseException) -> str:
    """Lower-cased haystack of provider error code/type/message for matching."""
    parts: list[str] = []
    body = getattr(exc, "body", None)
    error_obj: Any = body
    if isinstance(body, dict):
        inner = body.get("error")
        error_obj = inner if isinstance(inner, dict) else body
    if isinstance(error_obj, dict):
        for key in ("code", "type", "status", "message"):
            value = error_obj.get(key)
            if isinstance(value, str):
                parts.append(value)
    for attr in ("code", "type", "message"):
        value = getattr(exc, attr, None)
        if isinstance(value, str):
            parts.append(value)
    parts.append(str(exc))
    return " ".join(parts).lower()


def _category_for(status: int | None, blob: str) -> ProviderErrorCategory:
    # Quota first: an OpenAI ``insufficient_quota`` is delivered as HTTP 429, so
    # it must win over the generic 429-is-transient rule below.
    if any(marker in blob for marker in _QUOTA_MARKERS):
        return "quota_exhausted"
    if status in (401, 403):
        return "auth_permanent"
    if status == 404 and "model" in blob:
        return "auth_permanent"
    if any(marker in blob for marker in _AUTH_MARKERS):
        return "auth_permanent"
    if status == 429:
        return "transient"
    if status is not None and status >= 500:
        return "transient"
    if any(marker in blob for marker in _TRANSIENT_MARKERS):
        return "transient"
    return "unknown"


def classify_provider_error(
    exc: BaseException,
    *,
    provider: ProviderKind | str,
    model_id: str | None = None,
) -> ProviderCallError:
    """Normalize any provider exception into a categorized :class:`ProviderCallError`.

    Duck-typed on purpose: it reads ``status_code``/``code``/``response``/``body``
    so it works against the OpenAI, Anthropic, google-genai and Codex SDK error
    shapes (and any test double mimicking them) without importing each SDK's
    private exception hierarchy.
    """
    if isinstance(exc, ProviderCallError):
        return exc
    status = _status_code(exc)
    blob = _error_blob(exc)
    category = _category_for(status, blob)
    message = str(getattr(exc, "message", None) or str(exc) or exc.__class__.__name__)
    return ProviderCallError(
        message,
        category=category,
        provider=provider,
        status_code=status,
        retry_after=_retry_after(exc),
        model_id=model_id,
        original=exc,
    )


async def _call_with_retries(
    operation: Callable[[], Awaitable[_T]],
    *,
    provider: ProviderKind | str,
    model_id: str | None,
    max_attempts: int = DEFAULT_RETRY_MAX_ATTEMPTS,
    base_delay_s: float = DEFAULT_RETRY_BASE_DELAY_S,
    max_delay_s: float = DEFAULT_RETRY_MAX_DELAY_S,
) -> _T:
    """Run a provider SDK call, retrying ``transient`` failures with bounded backoff.

    Non-transient failures (``quota_exhausted``/``auth_permanent``/``unknown``)
    raise immediately so the caller does not burn time retrying something that
    cannot succeed. ``Retry-After`` from the provider takes precedence over the
    computed exponential delay.
    """
    attempt = 0
    while True:
        attempt += 1
        try:
            return await operation()
        except Exception as exc:  # noqa: BLE001 - re-raised as a classified error
            error = (
                exc
                if isinstance(exc, ProviderCallError)
                else classify_provider_error(exc, provider=provider, model_id=model_id)
            )
            if not error.retryable or attempt >= max_attempts:
                raise error from exc
            delay = (
                error.retry_after
                if error.retry_after is not None
                else min(max_delay_s, base_delay_s * (2 ** (attempt - 1)))
            )
        await asyncio.sleep(delay)

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
        response = await _call_with_retries(
            lambda: self._client.chat.completions.create(**payload),
            provider=self.endpoint.provider,
            model_id=self.model_id,
        )
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
        stream = await _call_with_retries(
            lambda: self._client.chat.completions.create(**payload),
            provider=self.endpoint.provider,
            model_id=self.model_id,
        )
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
        async for event in stream:
            event_type = getattr(event, "type", None)
            if event_type == "message_start":
                start_usage = getattr(getattr(event, "message", None), "usage", None)
                if start_usage is not None:
                    prompt_tokens = getattr(start_usage, "input_tokens", None)
            elif event_type == "content_block_delta":
                delta = event.delta
                if getattr(delta, "type", None) == "text_delta":
                    yield StreamChunk(delta=delta.text)
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
        self._client = AsyncOpenAI(
            base_url=endpoint.base_url or CODEX_BASE_URL,
            api_key="placeholder-oauth-token",
            default_headers={"OpenAI-Beta": "responses=v1", "originator": "fusionkit"},
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
        usage = Usage()
        finish_reason: str | None = None
        # Aggregate streamed function-call fragments by call id, preserving the
        # order the model emitted them so parallel tool calls round-trip intact.
        tool_fragments: dict[str, dict[str, str]] = {}
        tool_order: list[str] = []
        async for chunk in self._stream(messages, tools, tool_choice, extra):
            text_parts.append(chunk.delta)
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
        async for event in stream:
            event_type = getattr(event, "type", None)
            if event_type == "response.output_text.delta":
                yield StreamChunk(delta=getattr(event, "delta", "") or "")
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

    System messages collapse into `instructions`. User turns become `input_text`
    items and assistant text becomes `output_text`. Tool calls round-trip through
    the Responses function-tool protocol: an assistant turn's tool calls emit
    `function_call` items and a `tool` turn emits a `function_call_output` item
    paired back to the originating call via `call_id`.
    """
    instruction_parts: list[str] = []
    items: list[dict[str, Any]] = []
    for message in messages:
        if message.role == "system":
            if message.content:
                instruction_parts.append(message.content)
            continue
        if message.role == "tool":
            items.append(
                {
                    "type": "function_call_output",
                    "call_id": message.tool_call_id or "",
                    "output": message.content,
                }
            )
            continue
        if message.role == "assistant":
            if message.content:
                items.append(
                    {
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": message.content}],
                    }
                )
            for call in message.tool_calls or []:
                items.append(
                    {
                        "type": "function_call",
                        "call_id": call.id,
                        "name": call.name,
                        "arguments": call.arguments,
                    }
                )
            continue
        items.append(
            {"role": "user", "content": [{"type": "input_text", "text": message.content}]}
        )
    return "\n".join(instruction_parts), items


def _codex_tools(tools: Sequence[ToolDefinition]) -> list[dict[str, Any]]:
    # Responses-API function tools are flat (name/description/parameters at the
    # top level alongside `type`), unlike Chat Completions' nested `function` key.
    return [
        {
            "type": "function",
            "name": tool["name"],
            "description": tool.get("description", ""),
            "parameters": tool.get("parameters", {"type": "object", "properties": {}}),
        }
        for tool in tools
    ]


def _codex_tool_choice(tool_choice: ToolChoice) -> Any:
    if isinstance(tool_choice, str):
        return tool_choice
    return {"type": "function", "name": tool_choice["name"]}


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
