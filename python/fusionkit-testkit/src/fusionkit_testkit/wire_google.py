"""Google GenAI wire rendering for the provider simulator."""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

from fusionkit_testkit.behaviors import Behavior

_RPC_STATUS = {
    400: "INVALID_ARGUMENT",
    401: "UNAUTHENTICATED",
    403: "PERMISSION_DENIED",
    404: "NOT_FOUND",
    429: "RESOURCE_EXHAUSTED",
    500: "INTERNAL",
    503: "UNAVAILABLE",
    529: "UNAVAILABLE",
}


def error_body(behavior: Behavior) -> dict[str, Any]:
    assert behavior.error is not None
    return {
        "error": {
            "code": behavior.error.status,
            "message": behavior.error.message,
            "status": _RPC_STATUS.get(behavior.error.status, "UNKNOWN"),
        }
    }


def _usage_metadata(behavior: Behavior) -> dict[str, int]:
    completion = behavior.resolved_completion_tokens()
    return {
        "promptTokenCount": behavior.prompt_tokens,
        "candidatesTokenCount": completion,
        "totalTokenCount": behavior.prompt_tokens + completion,
    }


def _function_call(call_id: str, name: str, arguments: str) -> dict[str, Any]:
    try:
        args = json.loads(arguments or "{}")
    except json.JSONDecodeError:
        args = {}
    return {"functionCall": {"id": call_id, "name": name, "args": args}}


def _parts(behavior: Behavior) -> list[dict[str, Any]]:
    parts: list[dict[str, Any]] = []
    if behavior.reasoning is not None:
        parts.append({"text": behavior.reasoning, "thought": True})
    if behavior.reply is not None:
        parts.append({"text": behavior.reply})
    parts.extend(_function_call(call.id, call.name, call.arguments) for call in behavior.tool_calls)
    return parts


def generate_content_body(behavior: Behavior) -> dict[str, Any]:
    return {
        "candidates": [
            {
                "content": {"role": "model", "parts": _parts(behavior)},
                "finishReason": "STOP",
                "index": 0,
            }
        ],
        "usageMetadata": _usage_metadata(behavior),
        "modelVersion": "simulated",
    }


def _tokenize(text: str) -> list[str]:
    parts = text.split(" ")
    return [part + (" " if index < len(parts) - 1 else "") for index, part in enumerate(parts)]


def stream_frames(behavior: Behavior) -> Iterator[str]:
    """Yield JSON payloads for a ``streamGenerateContent`` SSE stream."""

    def chunk(parts: list[dict[str, Any]], *, final: bool = False) -> str:
        candidate: dict[str, Any] = {"content": {"role": "model", "parts": parts}, "index": 0}
        payload: dict[str, Any] = {"candidates": [candidate]}
        if final:
            candidate["finishReason"] = "STOP"
            payload["usageMetadata"] = _usage_metadata(behavior)
        return json.dumps(payload)

    if behavior.reasoning is not None:
        for token in _tokenize(behavior.reasoning):
            yield chunk([{"text": token, "thought": True}])
    for token in _tokenize(behavior.text()):
        if token:
            yield chunk([{"text": token}])
    final_parts = [
        _function_call(call.id, call.name, call.arguments) for call in behavior.tool_calls
    ]
    yield chunk(final_parts, final=True)


def last_user_text(body: dict[str, Any]) -> str:
    contents = body.get("contents")
    if not isinstance(contents, list):
        return ""
    for content in reversed(contents):
        if isinstance(content, dict) and content.get("role") == "user":
            parts = content.get("parts")
            if isinstance(parts, list):
                return "".join(
                    part.get("text", "")
                    for part in parts
                    if isinstance(part, dict) and isinstance(part.get("text"), str)
                )
    return ""
