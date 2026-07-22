"""RouteKit's neutral OpenAI-compatible wire rendering for the simulator.

JSON completions carry ``choices[].message`` with nested ``function`` tool
calls; SSE streams open with a role frame, emit token-level content deltas,
split tool-call arguments across index-keyed fragments, close the choice with
a finish frame, and (only when ``stream_options.include_usage`` was requested,
like the real API) append a choice-less usage frame before ``[DONE]``.
"""

from __future__ import annotations

import json
import time
from collections.abc import Iterator
from typing import Any

from fusionkit_testkit.behaviors import Behavior


def _usage_json(behavior: Behavior) -> dict[str, int]:
    completion = behavior.resolved_completion_tokens()
    return {
        "prompt_tokens": behavior.prompt_tokens,
        "completion_tokens": completion,
        "total_tokens": behavior.prompt_tokens + completion,
    }


def error_body(behavior: Behavior) -> dict[str, Any]:
    assert behavior.error is not None
    return {
        "error": {
            "message": behavior.error.message,
            "type": behavior.error.error_type,
            "param": None,
            "code": behavior.error.code,
        }
    }


def completion_body(model: str, behavior: Behavior, response_id: str) -> dict[str, Any]:
    message: dict[str, Any] = {
        "role": "assistant",
        "content": behavior.reply if behavior.reply is not None else None,
    }
    if behavior.tool_calls:
        message["tool_calls"] = [
            {
                "id": call.id,
                "type": "function",
                "function": {"name": call.name, "arguments": call.arguments},
            }
            for call in behavior.tool_calls
        ]
    if behavior.reasoning is not None:
        # vLLM/SGLang-style out-of-band reasoning field; rides as a pydantic
        # optional extension field on the neutral gateway response.
        message["reasoning_content"] = behavior.reasoning
    return {
        "id": response_id,
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": message,
                "logprobs": None,
                "finish_reason": behavior.finish_reason(),
            }
        ],
        "usage": _usage_json(behavior),
    }


def _tokenize(text: str) -> list[str]:
    """Split text into token-ish fragments (words with trailing spaces)."""
    parts = text.split(" ")
    return [part + (" " if index < len(parts) - 1 else "") for index, part in enumerate(parts)]


def _argument_fragments(arguments: str) -> list[str]:
    """Split a JSON arguments string into a few partial fragments."""
    if len(arguments) <= 4:
        return [arguments]
    third = max(1, len(arguments) // 3)
    return [arguments[:third], arguments[third : 2 * third], arguments[2 * third :]]


def stream_frames(
    model: str,
    behavior: Behavior,
    response_id: str,
    include_usage: bool,
) -> Iterator[str]:
    """Yield the SSE payload lines (without the ``data: `` prefix) for a stream."""

    def chunk(delta: dict[str, Any], finish_reason: str | None = None) -> str:
        return json.dumps(
            {
                "id": response_id,
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": model,
                "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
            }
        )

    yield chunk({"role": "assistant", "content": ""})
    if behavior.reasoning is not None:
        for token in _tokenize(behavior.reasoning):
            yield chunk({"reasoning_content": token})
    for token in _tokenize(behavior.text()):
        if token:
            yield chunk({"content": token})
    if behavior.tool_calls:
        # The real wire sends id/name only on the first fragment of a slot and
        # keys every later fragment by index alone. With parallel calls a
        # single chunk's `tool_calls` array may carry fragments for SEVERAL
        # slots at once — emit the slot openings that way so consumers that
        # only read `tool_calls[0]` lose calls.
        yield chunk(
            {
                "tool_calls": [
                    {
                        "index": slot,
                        "id": call.id,
                        "type": "function",
                        "function": {"name": call.name, "arguments": ""},
                    }
                    for slot, call in enumerate(behavior.tool_calls)
                ]
            }
        )
        for slot, call in enumerate(behavior.tool_calls):
            for fragment in _argument_fragments(call.arguments):
                yield chunk({"tool_calls": [{"index": slot, "function": {"arguments": fragment}}]})
    yield chunk({}, finish_reason=behavior.finish_reason())
    if include_usage:
        yield json.dumps(
            {
                "id": response_id,
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": model,
                "choices": [],
                "usage": _usage_json(behavior),
            }
        )
