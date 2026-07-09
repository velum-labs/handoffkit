"""Scriptable provider behaviors.

A :class:`Behavior` describes how the simulator answers one model call. Tests
queue behaviors per model name (FIFO); a call with no queued behavior gets a
deterministic echo default so unscripted traffic is still observable instead
of failing. Every field round-trips through JSON so the HTTP control plane
(used by the Node test suite) can script exactly what in-process Python
tests can.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

BrokenStream = Literal["truncate", "garbage"]


@dataclass
class SimToolCall:
    """One tool call the simulated model asks for (OpenAI/Anthropic agnostic)."""

    id: str
    name: str
    arguments: str = "{}"

    def to_json(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "arguments": self.arguments}

    @staticmethod
    def from_json(data: dict[str, Any]) -> SimToolCall:
        return SimToolCall(
            id=str(data.get("id", "call_sim")),
            name=str(data.get("name", "tool")),
            arguments=str(data.get("arguments", "{}")),
        )


@dataclass
class SimError:
    """A provider-shaped error response.

    ``status``/``code``/``error_type``/``message`` are rendered into the wire
    dialect's native error body (OpenAI ``{"error": {...}}``, Anthropic
    ``{"type": "error", ...}``) so the real SDK exception classes — and
    FusionKit's ``classify_provider_error`` on top of them — see exactly what a
    real provider would send. ``retry_after`` (seconds) is emitted as a
    ``retry-after`` header.
    """

    status: int = 500
    code: str = "internal_error"
    error_type: str = "api_error"
    message: str = "simulated provider error"
    retry_after: float | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "code": self.code,
            "error_type": self.error_type,
            "message": self.message,
            "retry_after": self.retry_after,
        }

    @staticmethod
    def from_json(data: dict[str, Any]) -> SimError:
        retry_after = data.get("retry_after")
        return SimError(
            status=int(data.get("status", 500)),
            code=str(data.get("code", "internal_error")),
            error_type=str(data.get("error_type", "api_error")),
            message=str(data.get("message", "simulated provider error")),
            retry_after=float(retry_after) if retry_after is not None else None,
        )

    # -- canned provider failures (match the real wire spellings that
    # -- classify_provider_error keys on) --------------------------------

    @staticmethod
    def rate_limited(retry_after: float | None = 0.0) -> SimError:
        return SimError(
            status=429,
            code="rate_limit_exceeded",
            error_type="rate_limit_error",
            message="Rate limit reached, try again later.",
            retry_after=retry_after,
        )

    @staticmethod
    def quota_exhausted() -> SimError:
        return SimError(
            status=429,
            code="insufficient_quota",
            error_type="insufficient_quota",
            message="You exceeded your current quota, please check your plan and billing details.",
        )

    @staticmethod
    def invalid_api_key() -> SimError:
        return SimError(
            status=401,
            code="invalid_api_key",
            error_type="authentication_error",
            message="Incorrect API key provided.",
        )

    @staticmethod
    def context_overflow() -> SimError:
        return SimError(
            status=400,
            code="context_length_exceeded",
            error_type="invalid_request_error",
            message="This model's maximum context length is exceeded.",
        )

    @staticmethod
    def overloaded() -> SimError:
        return SimError(
            status=529,
            code="overloaded_error",
            error_type="overloaded_error",
            message="Overloaded",
        )

    @staticmethod
    def server_error() -> SimError:
        return SimError(status=500)


@dataclass
class Behavior:
    """How the simulator answers one model call.

    Exactly one of ``reply``/``tool_calls``/``error`` drives the response
    shape; ``reply`` and ``tool_calls`` may combine (text plus calls, like a
    real assistant turn). ``reasoning`` rides out-of-band (OpenAI
    ``reasoning_content`` / Anthropic ``thinking``). ``delay_s`` sleeps before
    answering (latency injection); ``chunk_delay_s`` paces stream frames.
    ``broken_stream`` corrupts a streaming response on purpose: ``truncate``
    closes the connection mid-stream, ``garbage`` emits an unparseable frame.
    """

    reply: str | None = None
    tool_calls: list[SimToolCall] = field(default_factory=list)
    reasoning: str | None = None
    error: SimError | None = None
    delay_s: float = 0.0
    chunk_delay_s: float = 0.0
    prompt_tokens: int = 7
    completion_tokens: int | None = None
    broken_stream: BrokenStream | None = None

    def finish_reason(self) -> str:
        return "tool_calls" if self.tool_calls else "stop"

    def text(self) -> str:
        return self.reply or ""

    def resolved_completion_tokens(self) -> int:
        if self.completion_tokens is not None:
            return self.completion_tokens
        return max(1, len(self.text().split()) + 4 * len(self.tool_calls))

    def to_json(self) -> dict[str, Any]:
        return {
            "reply": self.reply,
            "tool_calls": [call.to_json() for call in self.tool_calls],
            "reasoning": self.reasoning,
            "error": self.error.to_json() if self.error is not None else None,
            "delay_s": self.delay_s,
            "chunk_delay_s": self.chunk_delay_s,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "broken_stream": self.broken_stream,
        }

    @staticmethod
    def from_json(data: dict[str, Any]) -> Behavior:
        error = data.get("error")
        raw_calls = data.get("tool_calls") or []
        completion_tokens = data.get("completion_tokens")
        broken = data.get("broken_stream")
        return Behavior(
            reply=data.get("reply"),
            tool_calls=[SimToolCall.from_json(call) for call in raw_calls],
            reasoning=data.get("reasoning"),
            error=SimError.from_json(error) if isinstance(error, dict) else None,
            delay_s=float(data.get("delay_s", 0.0)),
            chunk_delay_s=float(data.get("chunk_delay_s", 0.0)),
            prompt_tokens=int(data.get("prompt_tokens", 7)),
            completion_tokens=int(completion_tokens) if completion_tokens is not None else None,
            broken_stream=broken if broken in ("truncate", "garbage") else None,
        )
