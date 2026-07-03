from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping, Sequence
from typing import Any, Literal, Protocol, TypeVar, assert_never, runtime_checkable

import httpx
from anthropic import AsyncAnthropic
from google import genai
from google.genai import types as genai_types
from openai import AsyncOpenAI

from fusionkit_core.config import FusionConfig, ModelEndpoint, ProviderKind, SamplingConfig
from fusionkit_core.credentials import resolve_credential
from fusionkit_core.providers import resolve_api_key
from fusionkit_core.types import (
    ChatMessage,
    ModelResponse,
    ProviderCost,
    StreamChunk,
    ToolCall,
    Usage,
)

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
#   context_overflow the prompt exceeded the model's context window. Retrying
#                    the same payload can never succeed; the caller must shrink
#                    the prompt (pack trajectories, drop evidence) or fall back.
#   unknown          could not be classified; treated as non-retryable.
ProviderErrorCategory = Literal[
    "transient", "quota_exhausted", "auth_permanent", "context_overflow", "unknown"
]

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
    "insufficient credits",
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
# Context-window overflow spellings across providers (all delivered as HTTP
# 400-family errors): OpenAI ``context_length_exceeded``, Anthropic "prompt is
# too long", Google "input token count exceeds", OpenRouter/proxies "request
# too large" / "maximum context length".
_CONTEXT_OVERFLOW_MARKERS = (
    "context_length_exceeded",
    "context length exceeded",
    "maximum context length",
    "prompt is too long",
    "input token count exceeds",
    "input length exceeds",
    "request too large",
    "request_too_large",
    "exceeds the context window",
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
    # Context overflow first: it is the most specific signal, and some spellings
    # arrive on status codes the generic rules below would misread (OpenAI's
    # ``request_too_large`` rides HTTP 429/413, which is not transient here —
    # retrying the same oversized payload can never succeed).
    if any(marker in blob for marker in _CONTEXT_OVERFLOW_MARKERS):
        return "context_overflow"
    # Quota next: an OpenAI ``insufficient_quota`` is delivered as HTTP 429, so
    # it must win over the generic 429-is-transient rule below.
    if any(marker in blob for marker in _QUOTA_MARKERS):
        return "quota_exhausted"
    # 402 Payment Required (e.g. OpenRouter with no credits): retrying the same
    # key will not help.
    if status == 402:
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

# OpenRouter app attribution (optional but recommended by OpenRouter): lets the
# traffic show up as FusionKit on openrouter.ai rankings/analytics.
OPENROUTER_ATTRIBUTION_HEADERS = {
    "HTTP-Referer": "https://github.com/velum-labs/handoffkit",
    "X-Title": "FusionKit",
}

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

    @property
    def max_context(self) -> int | None:
        """The model's context window (endpoint ``max_context``), or None.

        Travels on the client so budget-aware callers (the judge/synthesizer
        packing) see the limit of the *resolved* model even when it was
        selected per request. A read-only property on the protocol so
        implementations may use a plain attribute of any compatible type.
        """
        ...

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
        async with httpx.AsyncClient(timeout=min(self.endpoint.timeout_s, 10.0)) as client:
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
        # TODO(@000alen): why is this hardcoded for kimi? There must be a better more generic way
        # to enable reasoning for all models.
        if _openrouter_kimi_reasoning_enabled(self.endpoint):
            # OpenRouter exposes reasoning for Kimi via its unified `reasoning`
            # request object. Keep this narrowly scoped so non-reasoning
            # OpenRouter models preserve their current request shape, and let
            # explicit caller overrides win below.
            payload["reasoning"] = {"enabled": True, "exclude": False}
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
        async for event in stream:
            event_type = getattr(event, "type", None)
            if event_type == "message_start":
                start_usage = getattr(getattr(event, "message", None), "usage", None)
                if start_usage is not None:
                    prompt_tokens = getattr(start_usage, "input_tokens", None)
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
        self.max_context = endpoint.max_context
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


class GoogleModelClient:
    """Native Google Gemini (google-genai) client."""

    def __init__(self, endpoint: ModelEndpoint) -> None:
        self.endpoint = endpoint
        self.model_id = endpoint.id
        self.max_context = endpoint.max_context
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


class FakeModelClient:
    def __init__(
        self,
        model_id: str,
        responses: Sequence[str] | None = None,
        max_context: int | None = None,
        reasoning: str | None = None,
    ) -> None:
        self.model_id = model_id
        self.max_context = max_context
        self._responses = list(responses or [])
        # Optional out-of-band reasoning attached to every reply, so tests can
        # exercise the reasoning capture path without a real provider.
        self._reasoning = reasoning
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
            reasoning=self._reasoning,
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
        if self._reasoning is not None:
            yield StreamChunk(model_reasoning_delta=self._reasoning)
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


def _optional_float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def _optional_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        try:
            parsed = float(value)
        except ValueError:
            return None
        if parsed.is_integer():
            return int(parsed)
    return None


def _optional_str(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _openrouter_provider_cost_from_generation(
    generation_id: str,
    data: dict[str, Any],
) -> ProviderCost:
    return ProviderCost(
        source="provider",
        cost_usd=_optional_float(data.get("total_cost")),
        generation_id=_optional_str(data.get("id")) or generation_id,
        provider_name=_optional_str(data.get("provider_name")),
        upstream_inference_cost=_optional_float(data.get("upstream_inference_cost")),
        cache_discount=_optional_float(data.get("cache_discount")),
        lookup_status="ok",
        tokens_prompt=_optional_int(data.get("tokens_prompt")),
        tokens_completion=_optional_int(data.get("tokens_completion")),
        native_tokens_prompt=_optional_int(data.get("native_tokens_prompt")),
        native_tokens_completion=_optional_int(data.get("native_tokens_completion")),
        raw=data,
    )


def _usage_with_provider_cost(usage: Usage | None, provider_cost: ProviderCost) -> Usage:
    prompt_tokens = provider_cost.tokens_prompt
    completion_tokens = provider_cost.tokens_completion
    if prompt_tokens is None and usage is not None:
        prompt_tokens = usage.prompt_tokens
    if completion_tokens is None and usage is not None:
        completion_tokens = usage.completion_tokens
    total_tokens: int | None = None
    if prompt_tokens is not None and completion_tokens is not None:
        total_tokens = prompt_tokens + completion_tokens
    elif usage is not None:
        total_tokens = usage.total_tokens
    return Usage(
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        total_tokens=total_tokens,
    )


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


def _openrouter_kimi_reasoning_enabled(endpoint: ModelEndpoint) -> bool:
    """True when this OpenRouter endpoint should ask Kimi to generate reasoning."""
    return endpoint.provider == "openrouter" and "kimi" in endpoint.model.lower()


def _reasoning_details_text(details: Any) -> str | None:
    """Readable text from OpenRouter `reasoning_details`, if any.

    OpenRouter may return structured details such as
    ``{"type": "reasoning.text", "text": "..."}``, plus encrypted/redacted
    entries that intentionally carry no readable text. Preserve the readable
    text and ignore opaque blocks.
    """
    if isinstance(details, str) and details:
        return details
    if not isinstance(details, Sequence) or isinstance(details, (bytes, bytearray, str)):
        return None
    parts: list[str] = []
    for item in details:
        if not isinstance(item, Mapping):
            continue
        text = item.get("text")
        if isinstance(text, str) and text:
            parts.append(text)
    return "\n\n".join(parts) or None


def _reasoning_text(message_or_delta: Any) -> str | None:
    """Out-of-band reasoning from an OpenAI-compatible message or stream delta.

    Local MLX (this repo's mlx-lm fork) emits ``reasoning``; vLLM/SGLang-style
    servers emit ``reasoning_content``; OpenRouter can emit structured
    ``reasoning_details``. These ride as pydantic extra fields on the SDK
    models, so plain ``getattr`` reads them. Returns ``None`` when absent or
    empty so downstream ``if`` checks stay cheap.
    """
    if message_or_delta is None:
        return None
    for field in ("reasoning", "reasoning_content"):
        value = getattr(message_or_delta, field, None)
        if isinstance(value, str) and value:
            return value
    details = _reasoning_details_text(getattr(message_or_delta, "reasoning_details", None))
    if details:
        return details
    return None


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


def _openai_stream_tool_calls(tool_calls: Any) -> list[ToolCall]:
    """Convert one streamed delta's `tool_calls` array into fragment ToolCalls.

    Every entry is kept (a chunk may carry fragments for several parallel
    calls) and the provider's stream-local `index` rides along so the
    accumulator can fold fragments into the right call even when continuation
    fragments arrive with empty ids.
    """
    if not tool_calls:
        return []
    fragments: list[ToolCall] = []
    for call in tool_calls:
        function = getattr(call, "function", None)
        index = getattr(call, "index", None)
        fragments.append(
            ToolCall(
                id=getattr(call, "id", None) or "",
                name=(getattr(function, "name", None) or "") if function else "",
                arguments=(getattr(function, "arguments", None) or "") if function else "",
                index=index if isinstance(index, int) else None,
            )
        )
    return fragments


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


def _google_extract(
    response: Any,
) -> tuple[list[str], list[str], list[ToolCall], str | None]:
    """Split a Gemini response into (text, thoughts, tool calls, finish reason).

    Parts flagged ``thought`` (present when the caller enables
    ``thinking_config.include_thoughts``) are the model's reasoning summaries
    and must never leak into the answer text.
    """
    text_parts: list[str] = []
    thought_parts: list[str] = []
    tool_calls: list[ToolCall] = []
    finish_reason: str | None = None
    candidates = getattr(response, "candidates", None) or []
    for candidate in candidates:
        if getattr(candidate, "finish_reason", None) is not None:
            finish_reason = str(candidate.finish_reason)
        content = getattr(candidate, "content", None)
        for part in getattr(content, "parts", None) or []:
            if getattr(part, "text", None):
                if getattr(part, "thought", None):
                    thought_parts.append(part.text)
                else:
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
    return text_parts, thought_parts, tool_calls, finish_reason


def _loads_arguments(arguments: str) -> dict[str, Any]:
    try:
        loaded = json.loads(arguments or "{}")
    except json.JSONDecodeError as exc:
        # Never silently swallow corruption: an empty input object downstream
        # shows up as an inscrutable tool failure with no pointer back here.
        logging.getLogger("fusionkit.tool_calls").warning(
            "dropping malformed tool-call arguments during provider translation: "
            "len=%d error=%s preview=%r",
            len(arguments),
            exc,
            arguments[:120],
        )
        return {}
    return loaded if isinstance(loaded, dict) else {}
