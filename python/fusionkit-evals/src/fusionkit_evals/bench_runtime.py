"""Error taxonomy and retry logic for benchmark runs.

A reliable benchmark must never silently drop a task: an infrastructure failure
(timeout, rate limit, 5xx) that disproportionately hits hard tasks would shrink
the denominator and inflate the score. This module classifies failures into a
taxonomy and retries transient ones with exponential backoff before they count.
"""

from __future__ import annotations

import asyncio
import random
from collections.abc import Awaitable, Callable
from typing import Literal, TypeVar

# scored: measured pass/fail. model_failed: model produced an unusable/incorrect
# answer (counts against the model). infra_error: harness/provider failure that
# is not the model's fault (kept separate, retried first). excluded: task removed
# for a documented reason (e.g. special-judge problem we can't grade faithfully).
TaskOutcome = Literal["scored", "model_failed", "infra_error", "excluded"]

T = TypeVar("T")

_TRANSIENT_MARKERS = (
    "timeout",
    "timed out",
    "connection",
    "rate limit",
    "ratelimit",
    "too many requests",
    "429",
    "500",
    "502",
    "503",
    "504",
    "529",
    "overloaded",
    "service unavailable",
    "temporarily unavailable",
)


def is_transient(exc: BaseException) -> bool:
    """Whether a failure looks transient (retryable infra) vs a hard model error."""

    name = type(exc).__name__.lower()
    text = str(exc).lower()
    status = getattr(exc, "status_code", None) or getattr(exc, "status", None)
    if isinstance(status, int) and (status == 429 or status >= 500):
        return True
    blob = f"{name} {text}"
    return any(marker in blob for marker in _TRANSIENT_MARKERS)


def classify_exception(exc: BaseException) -> TaskOutcome:
    return "infra_error" if is_transient(exc) else "model_failed"


async def retry_async(
    factory: Callable[[], Awaitable[T]],
    *,
    attempts: int = 3,
    base_delay: float = 1.0,
    max_delay: float = 30.0,
    retry_on: Callable[[BaseException], bool] = is_transient,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    rng: random.Random | None = None,
) -> T:
    """Run ``factory()`` with exponential backoff + jitter on transient failures.

    ``factory`` must return a fresh awaitable each call. Non-retryable errors (per
    ``retry_on``) and the final attempt re-raise immediately.
    """

    jitter = rng or random.Random()
    last_exc: BaseException | None = None
    for attempt in range(attempts):
        try:
            return await factory()
        except BaseException as exc:  # noqa: BLE001 - re-raised below after classification
            last_exc = exc
            if attempt == attempts - 1 or not retry_on(exc):
                raise
            delay = min(max_delay, base_delay * (2**attempt))
            await sleep(delay * (0.5 + jitter.random()))
    raise last_exc if last_exc is not None else RuntimeError("retry_async: no attempts made")


__all__ = [
    "TaskOutcome",
    "classify_exception",
    "is_transient",
    "retry_async",
]
