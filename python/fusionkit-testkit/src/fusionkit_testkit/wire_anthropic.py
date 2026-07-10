"""Anthropic Messages wire rendering for the simulator.

Faithful to the real wire so the ``anthropic`` SDK parses these exactly as it
would the real API: JSON messages carry typed content blocks (``text`` /
``thinking`` / ``tool_use``); SSE streams emit the full named-event sequence
(``message_start`` with input-token usage, per-block ``content_block_start`` /
``content_block_delta`` / ``content_block_stop`` — including
``input_json_delta`` tool-argument fragments — then ``message_delta`` with
output-token usage and ``message_stop``).
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

from fusionkit_testkit.behaviors import Behavior


def error_body(behavior: Behavior) -> dict[str, Any]:
    assert behavior.error is not None
    return {
        "type": "error",
        "error": {"type": behavior.error.error_type, "message": behavior.error.message},
    }


def _content_blocks(behavior: Behavior) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    if behavior.reasoning is not None:
        blocks.append({"type": "thinking", "thinking": behavior.reasoning, "signature": "sim"})
    if behavior.reply is not None:
        blocks.append({"type": "text", "text": behavior.reply})
    for call in behavior.tool_calls:
        try:
            tool_input = json.loads(call.arguments or "{}")
        except json.JSONDecodeError:
            tool_input = {}
        blocks.append({"type": "tool_use", "id": call.id, "name": call.name, "input": tool_input})
    return blocks


def _stop_reason(behavior: Behavior) -> str:
    return "tool_use" if behavior.tool_calls else "end_turn"


def message_body(model: str, behavior: Behavior, message_id: str) -> dict[str, Any]:
    return {
        "id": message_id,
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": _content_blocks(behavior),
        "stop_reason": _stop_reason(behavior),
        "stop_sequence": None,
        "usage": {
            "input_tokens": behavior.prompt_tokens,
            "output_tokens": behavior.resolved_completion_tokens(),
        },
    }


def _tokenize(text: str) -> list[str]:
    parts = text.split(" ")
    return [part + (" " if index < len(parts) - 1 else "") for index, part in enumerate(parts)]


def _argument_fragments(arguments: str) -> list[str]:
    if len(arguments) <= 4:
        return [arguments]
    half = max(1, len(arguments) // 2)
    return [arguments[:half], arguments[half:]]


def stream_events(model: str, behavior: Behavior, message_id: str) -> Iterator[tuple[str, str]]:
    """Yield ``(event_name, json_payload)`` pairs for an SSE stream."""

    def event(name: str, payload: dict[str, Any]) -> tuple[str, str]:
        return name, json.dumps(payload)

    yield event(
        "message_start",
        {
            "type": "message_start",
            "message": {
                "id": message_id,
                "type": "message",
                "role": "assistant",
                "model": model,
                "content": [],
                "stop_reason": None,
                "stop_sequence": None,
                "usage": {"input_tokens": behavior.prompt_tokens, "output_tokens": 0},
            },
        },
    )
    index = 0
    if behavior.reasoning is not None:
        yield event(
            "content_block_start",
            {
                "type": "content_block_start",
                "index": index,
                "content_block": {"type": "thinking", "thinking": "", "signature": ""},
            },
        )
        for token in _tokenize(behavior.reasoning):
            yield event(
                "content_block_delta",
                {
                    "type": "content_block_delta",
                    "index": index,
                    "delta": {"type": "thinking_delta", "thinking": token},
                },
            )
        yield event("content_block_stop", {"type": "content_block_stop", "index": index})
        index += 1
    if behavior.reply is not None:
        yield event(
            "content_block_start",
            {
                "type": "content_block_start",
                "index": index,
                "content_block": {"type": "text", "text": ""},
            },
        )
        for token in _tokenize(behavior.reply):
            if token:
                yield event(
                    "content_block_delta",
                    {
                        "type": "content_block_delta",
                        "index": index,
                        "delta": {"type": "text_delta", "text": token},
                    },
                )
        yield event("content_block_stop", {"type": "content_block_stop", "index": index})
        index += 1
    for call in behavior.tool_calls:
        yield event(
            "content_block_start",
            {
                "type": "content_block_start",
                "index": index,
                "content_block": {
                    "type": "tool_use",
                    "id": call.id,
                    "name": call.name,
                    "input": {},
                },
            },
        )
        for fragment in _argument_fragments(call.arguments):
            yield event(
                "content_block_delta",
                {
                    "type": "content_block_delta",
                    "index": index,
                    "delta": {"type": "input_json_delta", "partial_json": fragment},
                },
            )
        yield event("content_block_stop", {"type": "content_block_stop", "index": index})
        index += 1
    yield event(
        "message_delta",
        {
            "type": "message_delta",
            "delta": {"stop_reason": _stop_reason(behavior), "stop_sequence": None},
            "usage": {"output_tokens": behavior.resolved_completion_tokens()},
        },
    )
    yield event("message_stop", {"type": "message_stop"})
