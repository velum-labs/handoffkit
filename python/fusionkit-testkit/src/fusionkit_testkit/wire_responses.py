"""OpenAI Responses API wire rendering for the simulator (the codex dialect).

FusionKit's ``codex`` provider speaks the stream-only Responses API through
the ``openai`` SDK, which validates every SSE event against its typed models —
so these frames carry the full required field sets: sequence numbers, item /
output / content indices, and a complete terminal ``Response`` snapshot with
typed output items and usage.
"""

from __future__ import annotations

import json
import time
from collections.abc import Iterator
from typing import Any

from fusionkit_testkit.behaviors import Behavior


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


def _usage_json(behavior: Behavior) -> dict[str, Any]:
    completion = behavior.resolved_completion_tokens()
    return {
        "input_tokens": behavior.prompt_tokens,
        "input_tokens_details": {"cached_tokens": 0},
        "output_tokens": completion,
        "output_tokens_details": {"reasoning_tokens": 0},
        "total_tokens": behavior.prompt_tokens + completion,
    }


def _output_items(behavior: Behavior, response_id: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    if behavior.reply is not None:
        items.append(
            {
                "id": f"{response_id}_msg0",
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "content": [{"type": "output_text", "text": behavior.reply, "annotations": []}],
            }
        )
    for index, call in enumerate(behavior.tool_calls):
        items.append(
            {
                "id": f"{response_id}_fc{index}",
                "type": "function_call",
                "call_id": call.id,
                "name": call.name,
                "arguments": call.arguments,
                "status": "completed",
            }
        )
    return items


def response_snapshot(
    model: str, behavior: Behavior, response_id: str, *, status: str
) -> dict[str, Any]:
    completed = status == "completed"
    return {
        "id": response_id,
        "object": "response",
        "created_at": int(time.time()),
        "model": model,
        "status": status,
        "output": _output_items(behavior, response_id) if completed else [],
        "parallel_tool_calls": True,
        "tool_choice": "auto",
        "tools": [],
        **({"usage": _usage_json(behavior)} if completed else {}),
    }


def _tokenize(text: str) -> list[str]:
    parts = text.split(" ")
    return [part + (" " if index < len(parts) - 1 else "") for index, part in enumerate(parts)]


def _argument_fragments(arguments: str) -> list[str]:
    if len(arguments) <= 4:
        return [arguments]
    half = max(1, len(arguments) // 2)
    return [arguments[:half], arguments[half:]]


def stream_events(model: str, behavior: Behavior, response_id: str) -> Iterator[tuple[str, str]]:
    """Yield ``(event_name, json_payload)`` pairs for a Responses SSE stream."""
    seq = 0

    def event(payload: dict[str, Any]) -> tuple[str, str]:
        nonlocal seq
        seq += 1
        payload["sequence_number"] = seq
        return str(payload["type"]), json.dumps(payload)

    yield event(
        {
            "type": "response.created",
            "response": response_snapshot(model, behavior, response_id, status="in_progress"),
        }
    )
    if behavior.reasoning is not None:
        for token in _tokenize(behavior.reasoning):
            yield event(
                {
                    "type": "response.reasoning_summary_text.delta",
                    "delta": token,
                    "item_id": f"{response_id}_rs0",
                    "output_index": 0,
                    "summary_index": 0,
                }
            )
    if behavior.reply is not None:
        for token in _tokenize(behavior.reply):
            if not token:
                continue
            yield event(
                {
                    "type": "response.output_text.delta",
                    "delta": token,
                    "item_id": f"{response_id}_msg0",
                    "content_index": 0,
                    "output_index": 0,
                    "logprobs": [],
                }
            )
    for index, call in enumerate(behavior.tool_calls):
        item_id = f"{response_id}_fc{index}"
        yield event(
            {
                "type": "response.output_item.added",
                "output_index": index,
                "item": {
                    "id": item_id,
                    "type": "function_call",
                    "call_id": call.id,
                    "name": call.name,
                    "arguments": "",
                    "status": "in_progress",
                },
            }
        )
        for fragment in _argument_fragments(call.arguments):
            yield event(
                {
                    "type": "response.function_call_arguments.delta",
                    "delta": fragment,
                    "item_id": item_id,
                    "output_index": index,
                }
            )
    yield event(
        {
            "type": "response.completed",
            "response": response_snapshot(model, behavior, response_id, status="completed"),
        }
    )


def last_user_text(body: dict[str, Any]) -> str:
    """Last user text from a Responses `input` items array (or plain string)."""
    input_items = body.get("input")
    if isinstance(input_items, str):
        return input_items
    if not isinstance(input_items, list):
        return ""
    for item in reversed(input_items):
        if not isinstance(item, dict) or item.get("role") != "user":
            continue
        content = item.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return "".join(
                part.get("text", "")
                for part in content
                if isinstance(part, dict) and isinstance(part.get("text"), str)
            )
    return ""
