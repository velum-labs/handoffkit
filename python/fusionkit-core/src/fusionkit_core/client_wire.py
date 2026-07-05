from __future__ import annotations

import json
import logging
from collections.abc import Mapping, Sequence
from typing import Any

from google.genai import types as genai_types

from fusionkit_core.client_types import ToolChoice, ToolDefinition
from fusionkit_core.types import ChatMessage, ProviderCost, ToolCall, Usage


def _optional_float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def _optional_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        try:
            parsed = float(value)
        except ValueError:
            return None
        if parsed.is_integer():
            return int(parsed)
    return None


def _optional_str(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _openrouter_provider_cost_from_generation(
    generation_id: str,
    data: dict[str, Any],
) -> ProviderCost:
    return ProviderCost(
        source="provider",
        cost_usd=_optional_float(data.get("total_cost")),
        generation_id=_optional_str(data.get("id")) or generation_id,
        provider_name=_optional_str(data.get("provider_name")),
        upstream_inference_cost=_optional_float(data.get("upstream_inference_cost")),
        cache_discount=_optional_float(data.get("cache_discount")),
        lookup_status="ok",
        tokens_prompt=_optional_int(data.get("tokens_prompt")),
        tokens_completion=_optional_int(data.get("tokens_completion")),
        native_tokens_prompt=_optional_int(data.get("native_tokens_prompt")),
        native_tokens_completion=_optional_int(data.get("native_tokens_completion")),
        raw=data,
    )


def _usage_with_provider_cost(usage: Usage | None, provider_cost: ProviderCost) -> Usage:
    prompt_tokens = provider_cost.tokens_prompt
    completion_tokens = provider_cost.tokens_completion
    if prompt_tokens is None and usage is not None:
        prompt_tokens = usage.prompt_tokens
    if completion_tokens is None and usage is not None:
        completion_tokens = usage.completion_tokens
    total_tokens: int | None = None
    if prompt_tokens is not None and completion_tokens is not None:
        total_tokens = prompt_tokens + completion_tokens
    elif usage is not None:
        total_tokens = usage.total_tokens
    return Usage(
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        total_tokens=total_tokens,
    )


def _openai_messages(messages: Sequence[ChatMessage]) -> list[dict[str, Any]]:
    serialized: list[dict[str, Any]] = []
    for message in messages:
        entry: dict[str, Any] = {"role": message.role, "content": message.content}
        if message.name is not None:
            entry["name"] = message.name
        if message.tool_call_id is not None:
            entry["tool_call_id"] = message.tool_call_id
        if message.tool_calls:
            entry["tool_calls"] = [
                {
                    "id": call.id,
                    "type": "function",
                    "function": {"name": call.name, "arguments": call.arguments},
                }
                for call in message.tool_calls
            ]
        serialized.append(entry)
    return serialized


def _openai_tools(tools: Sequence[ToolDefinition]) -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": tool["name"],
                "description": tool.get("description", ""),
                "parameters": tool.get("parameters", {"type": "object", "properties": {}}),
            },
        }
        for tool in tools
    ]


def _openai_tool_choice(tool_choice: ToolChoice) -> Any:
    if isinstance(tool_choice, str):
        return tool_choice
    return {"type": "function", "function": {"name": tool_choice["name"]}}



def _reasoning_details_text(details: Any) -> str | None:
    """Readable text from OpenRouter `reasoning_details`, if any.

    OpenRouter may return structured details such as
    ``{"type": "reasoning.text", "text": "..."}``, plus encrypted/redacted
    entries that intentionally carry no readable text. Preserve the readable
    text and ignore opaque blocks.
    """
    if isinstance(details, str) and details:
        return details
    if not isinstance(details, Sequence) or isinstance(details, (bytes, bytearray, str)):
        return None
    parts: list[str] = []
    for item in details:
        if not isinstance(item, Mapping):
            continue
        text = item.get("text")
        if isinstance(text, str) and text:
            parts.append(text)
    return "\n\n".join(parts) or None


def _reasoning_text(message_or_delta: Any) -> str | None:
    """Out-of-band reasoning from an OpenAI-compatible message or stream delta.

    Local MLX (this repo's mlx-lm fork) emits ``reasoning``; vLLM/SGLang-style
    servers emit ``reasoning_content``; OpenRouter can emit structured
    ``reasoning_details``. These ride as pydantic extra fields on the SDK
    models, so plain ``getattr`` reads them. Returns ``None`` when absent or
    empty so downstream ``if`` checks stay cheap.
    """
    if message_or_delta is None:
        return None
    for field in ("reasoning", "reasoning_content"):
        value = getattr(message_or_delta, field, None)
        if isinstance(value, str) and value:
            return value
    details = _reasoning_details_text(getattr(message_or_delta, "reasoning_details", None))
    if details:
        return details
    return None


def _openai_tool_calls(tool_calls: Any) -> list[ToolCall]:
    if not tool_calls:
        return []
    parsed: list[ToolCall] = []
    for call in tool_calls:
        function = call.function
        parsed.append(
            ToolCall(
                id=call.id or "",
                name=function.name or "",
                arguments=function.arguments or "{}",
            )
        )
    return parsed


def _openai_stream_tool_calls(tool_calls: Any) -> list[ToolCall]:
    """Convert one streamed delta's `tool_calls` array into fragment ToolCalls.

    Every entry is kept (a chunk may carry fragments for several parallel
    calls) and the provider's stream-local `index` rides along so the
    accumulator can fold fragments into the right call even when continuation
    fragments arrive with empty ids.
    """
    if not tool_calls:
        return []
    fragments: list[ToolCall] = []
    for call in tool_calls:
        function = getattr(call, "function", None)
        index = getattr(call, "index", None)
        fragments.append(
            ToolCall(
                id=getattr(call, "id", None) or "",
                name=(getattr(function, "name", None) or "") if function else "",
                arguments=(getattr(function, "arguments", None) or "") if function else "",
                index=index if isinstance(index, int) else None,
            )
        )
    return fragments


def _anthropic_messages(
    messages: Sequence[ChatMessage],
) -> tuple[str, list[dict[str, Any]]]:
    system_parts: list[str] = []
    conversation: list[dict[str, Any]] = []
    for message in messages:
        if message.role == "system":
            system_parts.append(message.content)
            continue
        if message.role == "tool":
            conversation.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": message.tool_call_id or "",
                            "content": message.content,
                        }
                    ],
                }
            )
            continue
        if message.role == "assistant" and message.tool_calls:
            blocks: list[dict[str, Any]] = []
            if message.content:
                blocks.append({"type": "text", "text": message.content})
            for call in message.tool_calls:
                blocks.append(
                    {
                        "type": "tool_use",
                        "id": call.id,
                        "name": call.name,
                        "input": _loads_arguments(call.arguments),
                    }
                )
            conversation.append({"role": "assistant", "content": blocks})
            continue
        conversation.append({"role": message.role, "content": message.content})
    return "\n".join(part for part in system_parts if part), conversation


def _codex_input(messages: Sequence[ChatMessage]) -> tuple[str, list[dict[str, Any]]]:
    """Translate chat messages into Responses-API `instructions` + `input` items.

    System messages collapse into `instructions`. User turns become `input_text`
    items and assistant text becomes `output_text`. Tool calls round-trip through
    the Responses function-tool protocol: an assistant turn's tool calls emit
    `function_call` items and a `tool` turn emits a `function_call_output` item
    paired back to the originating call via `call_id`.
    """
    instruction_parts: list[str] = []
    items: list[dict[str, Any]] = []
    for message in messages:
        if message.role == "system":
            if message.content:
                instruction_parts.append(message.content)
            continue
        if message.role == "tool":
            items.append(
                {
                    "type": "function_call_output",
                    "call_id": message.tool_call_id or "",
                    "output": message.content,
                }
            )
            continue
        if message.role == "assistant":
            if message.content:
                items.append(
                    {
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": message.content}],
                    }
                )
            for call in message.tool_calls or []:
                items.append(
                    {
                        "type": "function_call",
                        "call_id": call.id,
                        "name": call.name,
                        "arguments": call.arguments,
                    }
                )
            continue
        items.append(
            {"role": "user", "content": [{"type": "input_text", "text": message.content}]}
        )
    return "\n".join(instruction_parts), items


def _codex_tools(tools: Sequence[ToolDefinition]) -> list[dict[str, Any]]:
    # Responses-API function tools are flat (name/description/parameters at the
    # top level alongside `type`), unlike Chat Completions' nested `function` key.
    return [
        {
            "type": "function",
            "name": tool["name"],
            "description": tool.get("description", ""),
            "parameters": tool.get("parameters", {"type": "object", "properties": {}}),
        }
        for tool in tools
    ]


def _codex_tool_choice(tool_choice: ToolChoice) -> Any:
    if isinstance(tool_choice, str):
        return tool_choice
    return {"type": "function", "name": tool_choice["name"]}


def _codex_usage(usage: Any) -> Usage | None:
    if usage is None:
        return None
    prompt_tokens = getattr(usage, "input_tokens", None)
    completion_tokens = getattr(usage, "output_tokens", None)
    total_tokens = getattr(usage, "total_tokens", None)
    if total_tokens is None and (prompt_tokens is not None or completion_tokens is not None):
        total_tokens = (prompt_tokens or 0) + (completion_tokens or 0)
    return Usage(
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        total_tokens=total_tokens,
    )


def _anthropic_tools(tools: Sequence[ToolDefinition]) -> list[dict[str, Any]]:
    return [
        {
            "name": tool["name"],
            "description": tool.get("description", ""),
            "input_schema": tool.get("parameters", {"type": "object", "properties": {}}),
        }
        for tool in tools
    ]


def _anthropic_tool_choice(tool_choice: ToolChoice) -> dict[str, Any]:
    if isinstance(tool_choice, str):
        mapping = {"auto": "auto", "required": "any", "any": "any", "none": "none"}
        return {"type": mapping.get(tool_choice, "auto")}
    return {"type": "tool", "name": tool_choice["name"]}


def _google_contents(
    messages: Sequence[ChatMessage],
) -> tuple[str, list[genai_types.Content]]:
    system_parts: list[str] = []
    contents: list[genai_types.Content] = []
    for message in messages:
        if message.role == "system":
            system_parts.append(message.content)
            continue
        if message.role == "tool":
            contents.append(
                genai_types.Content(
                    role="user",
                    parts=[
                        genai_types.Part.from_function_response(
                            name=message.name or "",
                            response={"result": message.content},
                        )
                    ],
                )
            )
            continue
        role = "model" if message.role == "assistant" else "user"
        parts: list[genai_types.Part] = []
        if message.content:
            parts.append(genai_types.Part.from_text(text=message.content))
        if message.tool_calls:
            for call in message.tool_calls:
                parts.append(
                    genai_types.Part.from_function_call(
                        name=call.name,
                        args=_loads_arguments(call.arguments),
                    )
                )
        contents.append(genai_types.Content(role=role, parts=parts))
    return "\n".join(part for part in system_parts if part), contents


def _google_tools(tools: Sequence[ToolDefinition]) -> list[genai_types.Tool]:
    declarations = [
        genai_types.FunctionDeclaration(
            name=tool["name"],
            description=tool.get("description", ""),
            parameters_json_schema=tool.get("parameters", {"type": "object", "properties": {}}),
        )
        for tool in tools
    ]
    return [genai_types.Tool(function_declarations=declarations)]


def _google_tool_config(tool_choice: ToolChoice) -> genai_types.ToolConfig:
    mode_enum = genai_types.FunctionCallingConfigMode
    if isinstance(tool_choice, str):
        mode = {
            "auto": mode_enum.AUTO,
            "required": mode_enum.ANY,
            "any": mode_enum.ANY,
            "none": mode_enum.NONE,
        }.get(tool_choice, mode_enum.AUTO)
        return genai_types.ToolConfig(
            function_calling_config=genai_types.FunctionCallingConfig(mode=mode)
        )
    return genai_types.ToolConfig(
        function_calling_config=genai_types.FunctionCallingConfig(
            mode=mode_enum.ANY,
            allowed_function_names=[tool_choice["name"]],
        )
    )


def _google_extract(
    response: Any,
) -> tuple[list[str], list[str], list[ToolCall], str | None]:
    """Split a Gemini response into (text, thoughts, tool calls, finish reason).

    Parts flagged ``thought`` (present when the caller enables
    ``thinking_config.include_thoughts``) are the model's reasoning summaries
    and must never leak into the answer text.
    """
    text_parts: list[str] = []
    thought_parts: list[str] = []
    tool_calls: list[ToolCall] = []
    finish_reason: str | None = None
    candidates = getattr(response, "candidates", None) or []
    for candidate in candidates:
        if getattr(candidate, "finish_reason", None) is not None:
            finish_reason = str(candidate.finish_reason)
        content = getattr(candidate, "content", None)
        for part in getattr(content, "parts", None) or []:
            if getattr(part, "text", None):
                if getattr(part, "thought", None):
                    thought_parts.append(part.text)
                else:
                    text_parts.append(part.text)
            function_call = getattr(part, "function_call", None)
            if function_call is not None:
                tool_calls.append(
                    ToolCall(
                        id=getattr(function_call, "id", None) or function_call.name,
                        name=function_call.name,
                        arguments=json.dumps(dict(function_call.args or {})),
                    )
                )
    return text_parts, thought_parts, tool_calls, finish_reason


def _loads_arguments(arguments: str) -> dict[str, Any]:
    try:
        loaded = json.loads(arguments or "{}")
    except json.JSONDecodeError as exc:
        # Never silently swallow corruption: an empty input object downstream
        # shows up as an inscrutable tool failure with no pointer back here.
        logging.getLogger("fusionkit.tool_calls").warning(
            "dropping malformed tool-call arguments during provider translation: "
            "len=%d error=%s preview=%r",
            len(arguments),
            exc,
            arguments[:120],
        )
        return {}
    return loaded if isinstance(loaded, dict) else {}
