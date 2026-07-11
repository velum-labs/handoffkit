from __future__ import annotations

import asyncio
import random
from collections.abc import Awaitable, Callable
from typing import Any, Literal, TypeVar

from fusionkit_core.config import ProviderKind

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
    "billing hard limit",
    "billing quota",
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


def _append_text(parts: list[str], value: object) -> None:
    if isinstance(value, str):
        parts.append(value)
    elif isinstance(value, int | float):
        parts.append(str(value))


def _error_haystacks(exc: BaseException) -> tuple[str, str, str]:
    """Split provider error text into structured fields vs free-form message haystacks."""
    structured_parts: list[str] = []
    message_parts: list[str] = []
    body = getattr(exc, "body", None)
    error_obj: Any = body
    if isinstance(body, dict):
        inner = body.get("error")
        error_obj = inner if isinstance(inner, dict) else body
    if isinstance(error_obj, dict):
        for key in ("code", "type", "status"):
            _append_text(structured_parts, error_obj.get(key))
        _append_text(message_parts, error_obj.get("message"))
    for attr in ("code", "type"):
        _append_text(structured_parts, getattr(exc, attr, None))
    message = getattr(exc, "message", None)
    if isinstance(message, str):
        message_parts.append(message)
    message_parts.append(str(exc))
    structured = " ".join(structured_parts).lower()
    message_blob = " ".join(message_parts).lower()
    full = f"{structured} {message_blob}".strip()
    return structured, message_blob, full


def _matches_markers(blob: str, markers: tuple[str, ...]) -> bool:
    return any(marker in blob for marker in markers)


def _category_for(
    status: int | None,
    structured: str,
    message: str,
    full: str,
) -> ProviderErrorCategory:
    if (status is None or status < 500) and _matches_markers(full, _CONTEXT_OVERFLOW_MARKERS):
        return "context_overflow"
    if status is not None and status >= 500:
        return "transient"
    quota_blob = structured
    if status is None or status in (400, 402):
        quota_blob = f"{structured} {message}".strip()
    if _matches_markers(quota_blob, _QUOTA_MARKERS):
        return "quota_exhausted"
    if status == 402:
        return "quota_exhausted"
    if status in (401, 403):
        return "auth_permanent"
    if status == 404 and "model" in full:
        return "auth_permanent"
    auth_blob = structured
    if status is None:
        auth_blob = f"{structured} {message}".strip()
    if _matches_markers(auth_blob, _AUTH_MARKERS):
        return "auth_permanent"
    if status == 429:
        return "transient"
    if _matches_markers(full, _TRANSIENT_MARKERS):
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
    structured, message_blob, full = _error_haystacks(exc)
    category = _category_for(status, structured, message_blob, full)
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
            cap = min(
                max_delay_s,
                error.retry_after
                if error.retry_after is not None
                else base_delay_s * 2 ** (attempt - 1),
            )
            delay = random.uniform(cap / 2, cap)
        await asyncio.sleep(delay)

