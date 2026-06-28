from __future__ import annotations

import base64
import json
import time
from collections.abc import AsyncIterator
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

from fusionkit_core.clients import (
    AnthropicModelClient,
    CodexResponsesClient,
    GoogleModelClient,
    OpenAICompatibleClient,
    _anthropic_messages,
    _anthropic_tools,
    _codex_input,
    _codex_tool_choice,
    _codex_tools,
    _google_contents,
    _google_tools,
    _openai_messages,
    _openai_tool_choice,
    _openai_tools,
    build_client,
)
from fusionkit_core.config import EndpointAuth, ModelEndpoint, ProviderKind
from fusionkit_core.credentials import clear_credential_cache
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
    assert isinstance(build_client(_endpoint("codex")), CodexResponsesClient)


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


async def test_anthropic_stream_chat_includes_prompt_tokens() -> None:
    # Anthropic delivers input_tokens on `message_start` and output_tokens on
    # `message_delta`. The terminal chunk's usage must carry BOTH so a fused turn
    # metered off the synthesizer step (Node gateway) does not under-report cost.
    client = AnthropicModelClient(_endpoint("anthropic"))
    events = [
        SimpleNamespace(
            type="message_start",
            message=SimpleNamespace(usage=SimpleNamespace(input_tokens=11, output_tokens=0)),
        ),
        SimpleNamespace(
            type="content_block_delta",
            delta=SimpleNamespace(type="text_delta", text="he"),
        ),
        SimpleNamespace(
            type="content_block_delta",
            delta=SimpleNamespace(type="text_delta", text="llo"),
        ),
        SimpleNamespace(
            type="message_delta",
            delta=SimpleNamespace(stop_reason="end_turn"),
            usage=SimpleNamespace(output_tokens=5),
        ),
    ]
    client._client.messages.create = AsyncMock(return_value=_aiter(events))

    chunks = [chunk async for chunk in client.stream_chat([ChatMessage(role="user", content="hi")])]

    assert "".join(chunk.delta for chunk in chunks) == "hello"
    terminal = chunks[-1]
    assert terminal.finish_reason == "end_turn"
    assert terminal.usage is not None
    assert terminal.usage.prompt_tokens == 11
    assert terminal.usage.completion_tokens == 5
    assert terminal.usage.total_tokens == 16


# --- subscription auth clients ---------------------------------------------


def _jwt(claims: dict[str, Any]) -> str:
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"header.{payload}.sig"


def _claude_code_endpoint(token_env: str) -> ModelEndpoint:
    return ModelEndpoint(
        id="claude-sub",
        provider="anthropic",
        model="claude-sonnet-4-5",
        auth=EndpointAuth(mode="claude-code", token_env=token_env),
    )


async def test_anthropic_claude_code_sends_bearer_and_spoof(monkeypatch) -> None:
    clear_credential_cache()
    monkeypatch.setenv("FK_CLAUDE_OAUTH", "tok-1")
    client = AnthropicModelClient(_claude_code_endpoint("FK_CLAUDE_OAUTH"))
    message = SimpleNamespace(
        content=[SimpleNamespace(type="text", text="hi")],
        stop_reason="end_turn",
        usage=SimpleNamespace(input_tokens=1, output_tokens=1),
        model_dump=lambda mode="json": {"ok": True},
    )
    client._client.messages.create = AsyncMock(return_value=message)

    await client.chat([ChatMessage(role="system", content="be terse"),
                       ChatMessage(role="user", content="hi")])

    kwargs = client._client.messages.create.call_args.kwargs
    assert kwargs["extra_headers"] == {"Authorization": "Bearer tok-1"}
    # The Claude Code identity must be a discrete first system block (not merged
    # into one string) so Anthropic routes the OAuth request into the Claude Code
    # rate-limit lane instead of the overage lane (persistent 429 on Opus/Sonnet).
    assert kwargs["system"][0] == {
        "type": "text",
        "text": "You are Claude Code, Anthropic's official CLI for Claude.",
    }
    assert kwargs["system"][1] == {"type": "text", "text": "be terse"}

    # Per-request resolution: a refreshed CLI token is picked up on the next call.
    monkeypatch.setenv("FK_CLAUDE_OAUTH", "tok-2")
    await client.chat([ChatMessage(role="user", content="again")])
    assert client._client.messages.create.call_args.kwargs["extra_headers"] == {
        "Authorization": "Bearer tok-2"
    }


async def test_codex_client_streams_and_sets_headers(monkeypatch) -> None:
    clear_credential_cache()
    token = _jwt(
        {
            "exp": time.time() + 3600,
            "https://api.openai.com/auth": {"chatgpt_account_id": "acct_x"},
        }
    )
    monkeypatch.setenv("FK_CODEX_OAUTH", token)
    endpoint = ModelEndpoint(
        id="codex-sub",
        provider="codex",
        model="gpt-5.5-codex",
        auth=EndpointAuth(mode="codex", token_env="FK_CODEX_OAUTH"),
    )
    client = CodexResponsesClient(endpoint)
    events = [
        SimpleNamespace(type="response.output_text.delta", delta="he"),
        SimpleNamespace(type="response.output_text.delta", delta="llo"),
        SimpleNamespace(
            type="response.completed",
            response=SimpleNamespace(
                usage=SimpleNamespace(input_tokens=3, output_tokens=2, total_tokens=5)
            ),
        ),
    ]
    client._client.responses.create = AsyncMock(return_value=_aiter(events))

    response = await client.chat([ChatMessage(role="user", content="hi")])

    assert response.content == "hello"
    assert response.finish_reason == "stop"
    assert response.usage.total_tokens == 5

    kwargs = client._client.responses.create.call_args.kwargs
    assert kwargs["stream"] is True
    assert kwargs["model"] == "gpt-5.5-codex"
    assert kwargs["extra_headers"]["Authorization"] == f"Bearer {token}"
    assert kwargs["extra_headers"]["chatgpt-account-id"] == "acct_x"
    # Live codex backend requirements: instructions are mandatory, storage must be
    # disabled, and max_output_tokens is rejected.
    assert kwargs["instructions"]
    assert kwargs["store"] is False
    assert "max_output_tokens" not in kwargs


def test_codex_input_round_trips_tool_calls_and_results() -> None:
    instructions, items = _codex_input(
        [
            ChatMessage(role="system", content="be terse"),
            ChatMessage(role="user", content="audit"),
            ChatMessage(
                role="assistant",
                content="looking",
                tool_calls=[ToolCall(id="call_1", name="run", arguments='{"cmd":"ls"}')],
            ),
            ChatMessage(role="tool", content="file.py", tool_call_id="call_1", name="run"),
        ]
    )

    assert instructions == "be terse"
    # user turn -> input_text
    assert items[0] == {"role": "user", "content": [{"type": "input_text", "text": "audit"}]}
    # assistant text -> output_text
    assert items[1] == {
        "role": "assistant",
        "content": [{"type": "output_text", "text": "looking"}],
    }
    # assistant tool call -> function_call paired by call_id
    assert items[2] == {
        "type": "function_call",
        "call_id": "call_1",
        "name": "run",
        "arguments": '{"cmd":"ls"}',
    }
    # tool result -> function_call_output referencing the same call_id
    assert items[3] == {
        "type": "function_call_output",
        "call_id": "call_1",
        "output": "file.py",
    }


def test_codex_tool_translation() -> None:
    tools = _codex_tools(TOOLS)
    # Responses-API function tools are flat (no nested `function` key).
    assert tools[0]["type"] == "function"
    assert tools[0]["name"] == "search"
    assert tools[0]["parameters"]["properties"]["q"]["type"] == "string"
    assert _codex_tool_choice("auto") == "auto"
    assert _codex_tool_choice({"name": "search"}) == {"type": "function", "name": "search"}


async def test_codex_chat_aggregates_streamed_tool_calls(monkeypatch) -> None:
    clear_credential_cache()
    monkeypatch.setenv("FK_CODEX_OAUTH", "header.payload.sig")
    endpoint = ModelEndpoint(
        id="codex-sub",
        provider="codex",
        model="gpt-5.5",
        auth=EndpointAuth(mode="codex", token_env="FK_CODEX_OAUTH"),
    )
    client = CodexResponsesClient(endpoint)
    events = [
        SimpleNamespace(type="response.output_text.delta", delta="on it"),
        SimpleNamespace(
            type="response.output_item.added",
            item=SimpleNamespace(
                type="function_call", id="fc_1", call_id="call_1", name="search", arguments=""
            ),
        ),
        SimpleNamespace(
            type="response.function_call_arguments.delta", item_id="fc_1", delta='{"q":'
        ),
        SimpleNamespace(
            type="response.function_call_arguments.delta", item_id="fc_1", delta='"x"}'
        ),
        SimpleNamespace(
            type="response.completed",
            response=SimpleNamespace(
                usage=SimpleNamespace(input_tokens=5, output_tokens=3, total_tokens=8)
            ),
        ),
    ]
    client._client.responses.create = AsyncMock(return_value=_aiter(events))

    response = await client.chat(
        [ChatMessage(role="user", content="find x")],
        tools=TOOLS,
        tool_choice="auto",
    )

    assert response.content == "on it"
    assert response.finish_reason == "stop"
    assert response.usage.total_tokens == 8
    assert len(response.tool_calls) == 1
    call = response.tool_calls[0]
    # The call id is the function `call_id` (pairs with function_call_output), and
    # the streamed argument fragments are concatenated into valid JSON.
    assert call.id == "call_1"
    assert call.name == "search"
    assert json.loads(call.arguments) == {"q": "x"}

    kwargs = client._client.responses.create.call_args.kwargs
    assert kwargs["tools"][0] == {
        "type": "function",
        "name": "search",
        "description": "Search the web",
        "parameters": {"type": "object", "properties": {"q": {"type": "string"}}},
    }
    assert kwargs["tool_choice"] == "auto"


async def test_codex_defaults_instructions_when_no_system_message(monkeypatch) -> None:
    clear_credential_cache()
    monkeypatch.setenv("FK_CODEX_OAUTH", "header.payload.sig")
    endpoint = ModelEndpoint(
        id="codex-sub",
        provider="codex",
        model="gpt-5.5",
        auth=EndpointAuth(mode="codex", token_env="FK_CODEX_OAUTH"),
    )
    client = CodexResponsesClient(endpoint)
    client._client.responses.create = AsyncMock(
        return_value=_aiter([SimpleNamespace(type="response.completed", response=None)])
    )

    await client.chat([ChatMessage(role="user", content="hi")])

    assert client._client.responses.create.call_args.kwargs["instructions"]
