from __future__ import annotations

import json
from collections.abc import AsyncIterator
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

from fusionkit_core.clients import (
    AnthropicModelClient,
    GoogleModelClient,
    OpenAICompatibleClient,
    _anthropic_messages,
    _anthropic_tools,
    _google_contents,
    _google_tools,
    _openai_messages,
    _openai_tool_choice,
    _openai_tools,
    build_client,
)
from fusionkit_core.config import ModelEndpoint, ProviderKind
from fusionkit_core.types import ChatMessage, ToolCall

TOOLS = [
    {
        "name": "search",
        "description": "Search the web",
        "parameters": {"type": "object", "properties": {"q": {"type": "string"}}},
    }
]


async def _aiter(items: list[Any]) -> AsyncIterator[Any]:
    for item in items:
        yield item


def _endpoint(provider: ProviderKind, model: str = "model") -> ModelEndpoint:
    return ModelEndpoint(
        id=f"{provider}-id",
        provider=provider,
        model=model,
        base_url="https://example.test",
    )


# --- factory dispatch -------------------------------------------------------


def test_build_client_dispatches_each_provider() -> None:
    assert isinstance(build_client(_endpoint("openai")), OpenAICompatibleClient)
    assert isinstance(build_client(_endpoint("openai-compatible")), OpenAICompatibleClient)
    assert isinstance(build_client(_endpoint("mlx-lm")), OpenAICompatibleClient)
    assert isinstance(build_client(_endpoint("custom")), OpenAICompatibleClient)
    assert isinstance(build_client(_endpoint("anthropic")), AnthropicModelClient)
    assert isinstance(build_client(_endpoint("google")), GoogleModelClient)


# --- message + tool translation --------------------------------------------


def test_openai_message_serialization_includes_tool_fields() -> None:
    messages = [
        ChatMessage(role="system", content="be terse"),
        ChatMessage(
            role="assistant",
            content="",
            tool_calls=[ToolCall(id="c1", name="search", arguments='{"q":"x"}')],
        ),
        ChatMessage(role="tool", content="result", tool_call_id="c1", name="search"),
    ]
    serialized = _openai_messages(messages)

    assert serialized[1]["tool_calls"][0]["function"]["name"] == "search"
    assert serialized[1]["tool_calls"][0]["type"] == "function"
    assert serialized[2]["tool_call_id"] == "c1"
    assert "tool_call_id" not in serialized[0]


def test_openai_tool_translation() -> None:
    tools = _openai_tools(TOOLS)
    assert tools[0]["type"] == "function"
    assert tools[0]["function"]["name"] == "search"
    assert _openai_tool_choice("auto") == "auto"
    assert _openai_tool_choice({"name": "search"}) == {
        "type": "function",
        "function": {"name": "search"},
    }


def test_anthropic_messages_split_system_and_tools() -> None:
    system_text, conversation = _anthropic_messages(
        [
            ChatMessage(role="system", content="rules"),
            ChatMessage(role="user", content="hi"),
            ChatMessage(
                role="assistant",
                content="thinking",
                tool_calls=[ToolCall(id="t1", name="search", arguments='{"q":"x"}')],
            ),
            ChatMessage(role="tool", content="done", tool_call_id="t1"),
        ]
    )

    assert system_text == "rules"
    assert conversation[0] == {"role": "user", "content": "hi"}
    assert conversation[1]["content"][1]["type"] == "tool_use"
    assert conversation[1]["content"][1]["input"] == {"q": "x"}
    assert conversation[2]["content"][0]["type"] == "tool_result"
    assert conversation[2]["content"][0]["tool_use_id"] == "t1"

    tools = _anthropic_tools(TOOLS)
    assert tools[0]["input_schema"]["properties"]["q"]["type"] == "string"


def test_google_contents_split_system_and_roles() -> None:
    system_text, contents = _google_contents(
        [
            ChatMessage(role="system", content="rules"),
            ChatMessage(role="user", content="hi"),
            ChatMessage(role="assistant", content="hello"),
        ]
    )

    assert system_text == "rules"
    assert contents[0].role == "user"
    assert contents[1].role == "model"

    tools = _google_tools(TOOLS)
    declarations = tools[0].function_declarations
    assert declarations is not None
    assert declarations[0].name == "search"


# --- response normalization (mocked SDKs) -----------------------------------


async def test_anthropic_chat_normalizes_text_and_tool_calls() -> None:
    client = AnthropicModelClient(_endpoint("anthropic"))
    message = SimpleNamespace(
        content=[
            SimpleNamespace(type="text", text="hello"),
            SimpleNamespace(type="tool_use", id="t1", name="search", input={"q": "x"}),
        ],
        stop_reason="tool_use",
        usage=SimpleNamespace(input_tokens=10, output_tokens=4),
        model_dump=lambda mode="json": {"ok": True},
    )
    client._client.messages.create = AsyncMock(return_value=message)

    response = await client.chat([ChatMessage(role="user", content="hi")], tools=TOOLS)

    assert response.content == "hello"
    assert response.finish_reason == "tool_use"
    assert response.usage.total_tokens == 14
    assert response.tool_calls[0].name == "search"
    assert json.loads(response.tool_calls[0].arguments) == {"q": "x"}


async def test_google_chat_normalizes_text_and_tool_calls() -> None:
    client = GoogleModelClient(_endpoint("google"))
    response_obj = SimpleNamespace(
        candidates=[
            SimpleNamespace(
                finish_reason="STOP",
                content=SimpleNamespace(
                    parts=[
                        SimpleNamespace(text="hi", function_call=None),
                        SimpleNamespace(
                            text=None,
                            function_call=SimpleNamespace(id=None, name="search", args={"q": "x"}),
                        ),
                    ]
                ),
            )
        ],
        usage_metadata=SimpleNamespace(
            prompt_token_count=3,
            candidates_token_count=4,
            total_token_count=7,
        ),
        model_dump=lambda mode="json": {"ok": True},
    )
    client._client.aio.models.generate_content = AsyncMock(return_value=response_obj)

    response = await client.chat([ChatMessage(role="user", content="hi")], tools=TOOLS)

    assert response.content == "hi"
    assert response.finish_reason == "STOP"
    assert response.usage.total_tokens == 7
    assert response.tool_calls[0].name == "search"
    assert json.loads(response.tool_calls[0].arguments) == {"q": "x"}


async def test_openai_stream_chat_yields_chunks() -> None:
    client = OpenAICompatibleClient(_endpoint("openai-compatible"))
    events = [
        SimpleNamespace(
            choices=[
                SimpleNamespace(
                    delta=SimpleNamespace(content="he", tool_calls=None),
                    finish_reason=None,
                )
            ],
            usage=None,
        ),
        SimpleNamespace(
            choices=[
                SimpleNamespace(
                    delta=SimpleNamespace(content="llo", tool_calls=None),
                    finish_reason="stop",
                )
            ],
            usage=SimpleNamespace(prompt_tokens=1, completion_tokens=2, total_tokens=3),
        ),
    ]
    client._client.chat.completions.create = AsyncMock(return_value=_aiter(events))

    chunks = [chunk async for chunk in client.stream_chat([ChatMessage(role="user", content="hi")])]

    assert "".join(chunk.delta for chunk in chunks) == "hello"
    assert chunks[-1].finish_reason == "stop"
    assert chunks[-1].usage is not None
    assert chunks[-1].usage.total_tokens == 3
