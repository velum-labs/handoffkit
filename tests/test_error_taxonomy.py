from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest
from fusionkit_core.clients import (
    OpenAICompatibleClient,
    ProviderCallError,
    ProviderErrorCategory,
    _call_with_retries,
    classify_provider_error,
)
from fusionkit_core.config import ModelEndpoint, ProviderKind, SamplingConfig
from fusionkit_core.producers import ChatTrajectoryProducer
from fusionkit_core.types import ChatMessage, ModelResponse


class _FakeSDKError(Exception):
    """Duck-typed stand-in for an OpenAI/Anthropic/Google/Codex SDK error.

    The classifier reads ``status_code``/``code``/``response``/``body`` rather
    than any concrete SDK exception type, so a single shape covers every
    provider here without importing each SDK's private hierarchy.
    """

    def __init__(
        self,
        *,
        status_code: int | None = None,
        code: int | str | None = None,
        message: str = "",
        body: dict[str, Any] | None = None,
        retry_after: str | None = None,
    ) -> None:
        super().__init__(message or str(code) or "error")
        if status_code is not None:
            self.status_code = status_code
        if code is not None:
            self.code = code
        if message:
            self.message = message
        if body is not None:
            self.body = body
        if retry_after is not None:
            self.response = SimpleNamespace(
                status_code=status_code, headers={"retry-after": retry_after}
            )


# (label, exception, provider, expected_category)
_CASES: list[tuple[str, _FakeSDKError, ProviderKind, ProviderErrorCategory]] = [
    (
        "openai_rate_limit",
        _FakeSDKError(
            status_code=429,
            body={"error": {"type": "rate_limit_error", "message": "Rate limit reached"}},
        ),
        "openai",
        "transient",
    ),
    (
        "openai_insufficient_quota",
        _FakeSDKError(
            status_code=429,
            body={
                "error": {
                    "code": "insufficient_quota",
                    "type": "insufficient_quota",
                    "message": "You exceeded your current quota",
                }
            },
        ),
        "openai",
        "quota_exhausted",
    ),
    (
        "openai_invalid_api_key",
        _FakeSDKError(
            status_code=401,
            body={"error": {"code": "invalid_api_key", "message": "Incorrect API key provided"}},
        ),
        "openai",
        "auth_permanent",
    ),
    (
        "openai_model_not_found",
        _FakeSDKError(
            status_code=404,
            body={"error": {"code": "model_not_found", "message": "The model does not exist"}},
        ),
        "openai",
        "auth_permanent",
    ),
    (
        "openai_server_error",
        _FakeSDKError(status_code=500, message="internal server error"),
        "openai",
        "transient",
    ),
    (
        "anthropic_overloaded",
        _FakeSDKError(
            status_code=529,
            body={"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}},
        ),
        "anthropic",
        "transient",
    ),
    (
        "anthropic_rate_limit",
        _FakeSDKError(
            status_code=429,
            body={"type": "error", "error": {"type": "rate_limit_error"}},
        ),
        "anthropic",
        "transient",
    ),
    (
        "anthropic_credit_balance",
        _FakeSDKError(
            status_code=400,
            body={
                "type": "error",
                "error": {
                    "type": "invalid_request_error",
                    "message": "Your credit balance is too low to access the API",
                },
            },
        ),
        "anthropic",
        "quota_exhausted",
    ),
    (
        "google_resource_exhausted",
        _FakeSDKError(code=429, message="429 RESOURCE_EXHAUSTED rate limit"),
        "google",
        "transient",
    ),
    (
        "google_permission_denied",
        _FakeSDKError(code=403, message="403 PERMISSION_DENIED"),
        "google",
        "auth_permanent",
    ),
    (
        "codex_unauthorized",
        _FakeSDKError(status_code=401, message="Unauthorized"),
        "codex",
        "auth_permanent",
    ),
    (
        "unclassified_bad_request",
        _FakeSDKError(status_code=400, message="malformed request"),
        "openai",
        "unknown",
    ),
]


@pytest.mark.parametrize("case", _CASES, ids=[case[0] for case in _CASES])
def test_classifier_categorizes_provider_errors(
    case: tuple[str, _FakeSDKError, ProviderKind, ProviderErrorCategory],
) -> None:
    _label, exc, provider, expected = case
    error = classify_provider_error(exc, provider=provider, model_id="m")

    assert isinstance(error, ProviderCallError)
    assert error.category == expected
    assert error.provider == provider
    assert error.model_id == "m"
    # Only transient failures are retryable.
    assert error.retryable is (expected == "transient")


def test_classifier_parses_retry_after_header() -> None:
    exc = _FakeSDKError(status_code=429, message="slow down", retry_after="7")
    error = classify_provider_error(exc, provider="openai")

    assert error.category == "transient"
    assert error.retry_after == 7.0


def test_classifier_is_idempotent_on_already_classified_error() -> None:
    original = classify_provider_error(_FakeSDKError(status_code=500), provider="openai")
    assert classify_provider_error(original, provider="anthropic") is original


async def test_retries_transient_then_succeeds(monkeypatch) -> None:
    sleeps: list[float] = []

    async def _fake_sleep(delay: float) -> None:
        sleeps.append(delay)

    monkeypatch.setattr("fusionkit_core.clients.asyncio.sleep", _fake_sleep)
    attempts = 0

    async def _operation() -> str:
        nonlocal attempts
        attempts += 1
        if attempts < 2:
            raise _FakeSDKError(status_code=503, message="service unavailable")
        return "ok"

    result = await _call_with_retries(_operation, provider="openai", model_id="m")

    assert result == "ok"
    assert attempts == 2
    assert len(sleeps) == 1  # exactly one backoff between the two attempts


async def test_retries_exhaust_then_raise_classified(monkeypatch) -> None:
    monkeypatch.setattr("fusionkit_core.clients.asyncio.sleep", AsyncMock())
    attempts = 0

    async def _operation() -> str:
        nonlocal attempts
        attempts += 1
        raise _FakeSDKError(status_code=429, message="rate limit")

    with pytest.raises(ProviderCallError) as excinfo:
        await _call_with_retries(_operation, provider="openai", model_id="m", max_attempts=3)

    assert excinfo.value.category == "transient"
    assert attempts == 3  # bounded by max_attempts


async def test_non_transient_raises_without_retry(monkeypatch) -> None:
    sleep = AsyncMock()
    monkeypatch.setattr("fusionkit_core.clients.asyncio.sleep", sleep)
    attempts = 0

    async def _operation() -> str:
        nonlocal attempts
        attempts += 1
        raise _FakeSDKError(status_code=401, message="invalid api key")

    with pytest.raises(ProviderCallError) as excinfo:
        await _call_with_retries(_operation, provider="openai", model_id="m")

    assert excinfo.value.category == "auth_permanent"
    assert attempts == 1  # auth errors are not retried
    sleep.assert_not_awaited()


async def test_openai_client_retries_transient_and_returns_response(monkeypatch) -> None:
    monkeypatch.setattr("fusionkit_core.clients.asyncio.sleep", AsyncMock())
    client = OpenAICompatibleClient(
        ModelEndpoint(id="m", provider="openai-compatible", model="x", base_url="https://t.test")
    )
    calls = {"n": 0}
    completion = SimpleNamespace(
        choices=[
            SimpleNamespace(
                message=SimpleNamespace(content="hi", tool_calls=None),
                finish_reason="stop",
            )
        ],
        usage=None,
        model_dump=lambda mode="json": {"ok": True},
    )

    async def _create(**_: Any) -> Any:
        calls["n"] += 1
        if calls["n"] < 2:
            raise _FakeSDKError(status_code=503, message="overloaded")
        return completion

    client._client.chat.completions.create = _create

    response = await client.chat([ChatMessage(role="user", content="hi")])

    assert response.content == "hi"
    assert calls["n"] == 2  # one transient failure, then success


class _RaisingClient:
    """A client whose chat raises an already-classified provider error."""

    def __init__(self, model_id: str, error: ProviderCallError) -> None:
        self.model_id = model_id
        self._error = error

    async def chat(self, *args: Any, **kwargs: Any) -> Any:
        raise self._error

    def stream_chat(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    async def aclose(self) -> None:
        return None


class _OkClient:
    def __init__(self, model_id: str) -> None:
        self.model_id = model_id

    async def chat(self, *args: Any, **kwargs: Any) -> Any:
        return ModelResponse(model_id=self.model_id, content="ok")

    def stream_chat(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    async def aclose(self) -> None:
        return None


async def test_panel_records_failure_category_and_keeps_survivors() -> None:
    # A classified provider failure becomes a failed trajectory whose metadata
    # records the category; the surviving model is still fused.
    error = ProviderCallError(
        "out of credits", category="quota_exhausted", provider="openai", status_code=429
    )
    producer = ChatTrajectoryProducer(
        {"good": _OkClient("good"), "bad": _RaisingClient("bad", error)}
    )

    trajectories = await producer.generate_panel(
        ["good", "bad"], [ChatMessage(role="user", content="hi")], SamplingConfig()
    )

    by_model = {trajectory.model_id: trajectory for trajectory in trajectories}
    assert by_model["good"].status == "succeeded"
    assert by_model["bad"].status == "failed"
    assert by_model["bad"].metadata["error_category"] == "quota_exhausted"
    assert by_model["bad"].metadata["provider"] == "openai"
    assert by_model["bad"].metadata["status_code"] == 429
