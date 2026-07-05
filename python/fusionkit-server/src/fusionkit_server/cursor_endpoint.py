"""Translate Cursor's BYOK request hybrid into OpenAI Chat Completions.

When Cursor's "Override OpenAI Base URL" feature is active, Cursor POSTs to
``{base_url}/chat/completions`` but — for agent mode and GPT-family routing —
the JSON body is shaped like the OpenAI *Responses* API (``input`` item list,
flat tool definitions, ``reasoning``/``text`` objects), while the response it
renders is standard Chat Completions SSE. This module is the pure translation
layer behind the ``/v1/cursor/*`` routes (the FusionKit analogue of
OpenRouter's ``/api/v1/cursor``): it maps the Responses-hybrid body onto the
Chat Completions shape the rest of the server already handles.

No I/O happens here. The translation is total: weird-but-parseable input is
never a reason to raise — unknown item and tool types are dropped with a
debug log so the boundary stays defensive without 4xx-ing on new shapes.
"""

from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger(__name__)

# Responses-only fields that must never reach provider clients or pydantic
# validation. ``reasoning``/``text`` carry Responses-side knobs (effort,
# verbosity) the internal request model does not support; the rest are
# Responses bookkeeping. ``stream_options`` is Chat Completions-legal but
# redundant here: the server always emits ``usage`` on the terminal chunk.
_STRIPPED_FIELDS = frozenset(
    {
        "input",
        "store",
        "include",
        "previous_response_id",
        "truncation",
        "prompt_cache_retention",
        "text",
        "reasoning",
        "stream_options",
        "max_output_tokens",
    }
)

# Fields copied through unchanged when present and non-null.
_PASSTHROUGH_FIELDS = ("model", "temperature", "top_p", "tool_choice", "stream")

# Permissive schema synthesized for grammar-based ("custom") tools that
# declare no JSON schema of their own; the model's call output flows back as
# a normal function tool call with the raw text under ``input``.
_CUSTOM_TOOL_PARAMETERS: dict[str, Any] = {
    "type": "object",
    "properties": {"input": {"type": "string"}},
    "required": ["input"],
}


def translate_cursor_request(body: dict[str, Any]) -> dict[str, Any]:
    """Map a Cursor BYOK request body onto a Chat Completions body.

    Dual-shape tolerance: Cursor only sends the Responses hybrid for some
    models/modes; Ask mode may send plain Chat Completions. A body that
    already carries ``messages`` is returned unchanged; a body with ``input``
    is translated. A body with neither yields an empty ``messages`` list —
    rejecting that is the route's job, not this function's.
    """
    if "messages" in body:
        return dict(body)
    translated: dict[str, Any] = {}
    for key in _PASSTHROUGH_FIELDS:
        if key in body and body[key] is not None:
            translated[key] = body[key]
    translated["messages"] = _input_items_to_messages(body.get("input"))
    tools = _translate_tools(body.get("tools"))
    if tools is not None:
        translated["tools"] = tools
    _translate_sampling(body, translated)
    dropped = sorted(
        key for key in body if key in _STRIPPED_FIELDS and key not in ("input", "max_output_tokens")
    )
    if dropped:
        logger.debug("cursor request: dropped Responses-only fields %s", dropped)
    return translated


def _input_items_to_messages(items: Any) -> list[dict[str, Any]]:
    """Flatten a Responses-API ``input`` item list into chat messages.

    Handles message items (typed or bare role/content objects),
    ``function_call`` items (folded into assistant ``tool_calls``, merging
    consecutive calls of the same assistant turn), ``function_call_output``
    items (``tool`` messages), and drops ``reasoning`` and unknown items.
    """
    if isinstance(items, str):
        # The Responses API also accepts a plain string as the whole input.
        return [{"role": "user", "content": items}]
    if not isinstance(items, list):
        return []
    messages: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            logger.debug("cursor request: dropped non-object input item %r", type(item).__name__)
            continue
        kind = item.get("type")
        if kind is None or kind == "message":
            messages.append(_message_from_item(item))
        elif kind == "function_call":
            _append_function_call(messages, item)
        elif kind == "function_call_output":
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": _as_str(item.get("call_id")),
                    "content": _stringify(item.get("output")),
                }
            )
        elif kind == "reasoning":
            # Encrypted/opaque reasoning items are never forwarded upstream.
            continue
        else:
            logger.debug("cursor request: dropped unknown input item type %r", kind)
    return messages


def _message_from_item(item: dict[str, Any]) -> dict[str, Any]:
    role = item.get("role")
    if role == "developer":
        role = "system"
    if role not in ("system", "user", "assistant", "tool"):
        role = "user"
    return {"role": role, "content": _content_text(item.get("content"))}


def _content_text(content: Any) -> str:
    """Concatenate the text parts of a Responses content value.

    Accepts a plain string or a parts list (``input_text`` / ``output_text``
    / anything else carrying a string ``text``); non-text parts such as
    ``input_image`` are ignored rather than rejected.
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict) and isinstance(part.get("text"), str):
                parts.append(part["text"])
        return "".join(parts)
    return ""


def _append_function_call(messages: list[dict[str, Any]], item: dict[str, Any]) -> None:
    """Fold a ``function_call`` item into the current assistant turn.

    Consecutive function calls after the same assistant message extend that
    message's ``tool_calls`` list; otherwise a new assistant message opens.
    """
    call = {
        "id": _as_str(item.get("call_id")) or _as_str(item.get("id")),
        "type": "function",
        "function": {
            "name": _as_str(item.get("name")),
            "arguments": _stringify(item.get("arguments")) or "{}",
        },
    }
    last = messages[-1] if messages else None
    if last is not None and last.get("role") == "assistant":
        last.setdefault("tool_calls", []).append(call)
        return
    messages.append({"role": "assistant", "content": "", "tool_calls": [call]})


def _translate_tools(tools: Any) -> list[dict[str, Any]] | None:
    """Map Responses tool definitions onto Chat Completions nested tools.

    Cursor sends flat function tools (``{type: "function", name, ...}``) and
    grammar-based custom tools (``{type: "custom", name, format}``). Flat
    tools are nested under ``function``; custom tools become plain function
    tools with their declared schema or a permissive synthesized one.
    Already-nested tools pass through unchanged; other typed entries are
    forwarded as-is for the server's downstream tool normalization.
    """
    if not isinstance(tools, list) or not tools:
        return None
    translated: list[dict[str, Any]] = []
    for entry in tools:
        if not isinstance(entry, dict):
            logger.debug("cursor request: dropped non-object tool entry %r", type(entry).__name__)
            continue
        if isinstance(entry.get("function"), dict):
            translated.append(entry)
            continue
        kind = entry.get("type")
        if kind == "function":
            translated.append(_nested_function_tool(entry, _default_parameters(entry)))
        elif kind == "custom":
            translated.append(_nested_function_tool(entry, _custom_parameters(entry)))
        else:
            # Typed nameless tools (e.g. web_search) and future shapes flow
            # through; the server-side tool normalization decides their fate.
            translated.append(entry)
    return translated or None


def _nested_function_tool(entry: dict[str, Any], parameters: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": _as_str(entry.get("name")),
            "description": _as_str(entry.get("description")),
            "parameters": parameters,
        },
    }


def _default_parameters(entry: dict[str, Any]) -> dict[str, Any]:
    parameters = entry.get("parameters")
    if isinstance(parameters, dict):
        return parameters
    return {"type": "object", "properties": {}}


def _custom_parameters(entry: dict[str, Any]) -> dict[str, Any]:
    parameters = entry.get("parameters")
    if isinstance(parameters, dict):
        return parameters
    return dict(_CUSTOM_TOOL_PARAMETERS)


def _translate_sampling(body: dict[str, Any], translated: dict[str, Any]) -> None:
    """Fold Responses sampling names into Chat Completions ones in place."""
    max_tokens = body.get("max_output_tokens", body.get("max_tokens"))
    if isinstance(max_tokens, int):
        translated["max_tokens"] = max_tokens


def _as_str(value: Any) -> str:
    return value if isinstance(value, str) else ""


def _stringify(value: Any) -> str:
    """Stringify a non-string tool output/arguments value losslessly."""
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    try:
        return json.dumps(value)
    except (TypeError, ValueError):
        return str(value)
