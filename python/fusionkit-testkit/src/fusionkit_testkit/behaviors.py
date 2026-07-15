"""Scriptable RouteKit gateway behaviors.

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
    """One tool call the simulated model asks for."""

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
    """An error response from the simulated RouteKit gateway."""

    status: int = 500
    code: str = "internal_error"
    error_type: str = "api_error"
    message: str = "simulated RouteKit error"

    def to_json(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "code": self.code,
            "error_type": self.error_type,
            "message": self.message,
        }

    @staticmethod
    def from_json(data: dict[str, Any]) -> SimError:
        return SimError(
            status=int(data.get("status", 500)),
            code=str(data.get("code", "internal_error")),
            error_type=str(data.get("error_type", "api_error")),
            message=str(data.get("message", "simulated RouteKit error")),
        )


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
    ``chunk_bytes`` re-splits the streamed SSE bytes into wire chunks of that
    size, crossing frame and UTF-8 rune boundaries — gateways make no
    chunk-alignment promises, so client stream parsing must reassemble any
    split losslessly.
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
    #: When set (and streaming), the rendered SSE bytes are re-chunked into
    #: wire chunks of exactly this many bytes (the last may be shorter),
    #: splitting frames and multi-byte UTF-8 runes at arbitrary boundaries.
    chunk_bytes: int | None = None
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
            "chunk_bytes": self.chunk_bytes,
        }

    @staticmethod
    def from_json(data: dict[str, Any]) -> Behavior:
        error = data.get("error")
        raw_calls = data.get("tool_calls") or []
        completion_tokens = data.get("completion_tokens")
        broken = data.get("broken_stream")
        chunk_bytes = data.get("chunk_bytes")
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
            chunk_bytes=int(chunk_bytes) if chunk_bytes is not None else None,
        )
