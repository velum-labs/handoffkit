"""Tests for the Cursor BYOK shim: the pure Responses-hybrid translation in
``cursor_endpoint`` plus the ``/v1/cursor/*`` routes that delegate into the
regular chat-completions path."""

from __future__ import annotations

import json
from typing import Any

from fastapi.testclient import TestClient
from fusionkit_core.clients import FakeModelClient
from fusionkit_core.config import FusionConfig, ModelEndpoint
from fusionkit_server import create_app
from fusionkit_server.cursor_endpoint import translate_cursor_request

# The documented Cursor agent-mode request: a Responses-API body POSTed to a
# chat-completions path (Cursor's known BYOK hybrid).
AGENT_MODE_BODY: dict[str, Any] = {
    "model": "gpt-5.5",
    "input": [
        {"type": "message", "role": "developer", "content": "You are a coding agent."},
        {
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "fix the bug"}],
        },
        {"type": "reasoning", "encrypted_content": "opaque-blob"},
        {
            "type": "message",
            "role": "assistant",
            "content": [{"type": "output_text", "text": "Reading the file."}],
        },
        {
            "type": "function_call",
            "call_id": "call_1",
            "name": "read_file",
            "arguments": '{"path": "a.py"}',
        },
        {"type": "function_call_output", "call_id": "call_1", "output": "print('hi')"},
    ],
    "stream": True,
    "store": False,
    "include": ["reasoning.encrypted_content"],
    "reasoning": {"effort": "medium", "summary": "auto"},
    "text": {"verbosity": "low"},
    "stream_options": {"include_usage": True},
    "tools": [
        {
            "type": "function",
            "name": "read_file",
            "description": "Read a file",
            "parameters": {"type": "object", "properties": {"path": {"type": "string"}}},
        },
        {"type": "custom", "name": "ApplyPatch", "description": "Apply a patch", "format": {}},
    ],
    "tool_choice": "auto",
    "max_output_tokens": 4096,
    "temperature": 0.2,
}


def test_translate_full_agent_mode_payload() -> None:
    translated = translate_cursor_request(AGENT_MODE_BODY)

    assert translated["model"] == "gpt-5.5"
    assert translated["stream"] is True
    assert translated["temperature"] == 0.2
    assert translated["tool_choice"] == "auto"
    assert translated["max_tokens"] == 4096
    assert translated["messages"] == [
        {"role": "system", "content": "You are a coding agent."},
        {"role": "user", "content": "fix the bug"},
        {
            "role": "assistant",
            "content": "Reading the file.",
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "read_file", "arguments": '{"path": "a.py"}'},
                }
            ],
        },
        {"role": "tool", "tool_call_id": "call_1", "content": "print('hi')"},
    ]
    # Responses-only fields must never survive translation.
    for stripped in (
        "input",
        "store",
        "include",
        "reasoning",
        "text",
        "stream_options",
        "max_output_tokens",
    ):
        assert stripped not in translated


def test_translate_tools_nested_and_custom() -> None:
    translated = translate_cursor_request(AGENT_MODE_BODY)

    assert translated["tools"] == [
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read a file",
                "parameters": {"type": "object", "properties": {"path": {"type": "string"}}},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "ApplyPatch",
                "description": "Apply a patch",
                "parameters": {
                    "type": "object",
                    "properties": {"input": {"type": "string"}},
                    "required": ["input"],
                },
            },
        },
    ]


def test_translate_content_part_lists_ignore_non_text_parts() -> None:
    translated = translate_cursor_request(
        {
            "model": "m",
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": "look at "},
                        {"type": "input_image", "image_url": "data:image/png;base64,xxx"},
                        {"type": "input_text", "text": "this"},
                    ],
                }
            ],
        }
    )

    assert translated["messages"] == [{"role": "user", "content": "look at this"}]


def test_translate_bare_role_content_items_are_messages() -> None:
    translated = translate_cursor_request(
        {"model": "m", "input": [{"role": "user", "content": "plain"}]}
    )

    assert translated["messages"] == [{"role": "user", "content": "plain"}]


def test_translate_consecutive_function_calls_fold_into_one_assistant_turn() -> None:
    translated = translate_cursor_request(
        {
            "model": "m",
            "input": [
                {"type": "function_call", "call_id": "c1", "name": "a", "arguments": "{}"},
                {"type": "function_call", "call_id": "c2", "name": "b", "arguments": "{}"},
                {"type": "function_call_output", "call_id": "c1", "output": {"ok": True}},
                {"type": "function_call", "call_id": "c3", "name": "c", "arguments": "{}"},
            ],
        }
    )

    messages = translated["messages"]
    assert [message["role"] for message in messages] == ["assistant", "tool", "assistant"]
    assert [call["id"] for call in messages[0]["tool_calls"]] == ["c1", "c2"]
    # Non-string tool output is stringified, not rejected.
    assert messages[1] == {"role": "tool", "tool_call_id": "c1", "content": '{"ok": true}'}
    assert [call["id"] for call in messages[2]["tool_calls"]] == ["c3"]


def test_translate_drops_reasoning_and_unknown_items() -> None:
    translated = translate_cursor_request(
        {
            "model": "m",
            "input": [
                {"type": "reasoning", "encrypted_content": "blob"},
                {"type": "mystery_item", "payload": 1},
                "not-an-object",
                {"type": "message", "role": "user", "content": "hi"},
            ],
        }
    )

    assert translated["messages"] == [{"role": "user", "content": "hi"}]


def test_translate_developer_role_maps_to_system() -> None:
    translated = translate_cursor_request(
        {"model": "m", "input": [{"type": "message", "role": "developer", "content": "rules"}]}
    )

    assert translated["messages"] == [{"role": "system", "content": "rules"}]


def test_translate_string_input_becomes_user_message() -> None:
    translated = translate_cursor_request({"model": "m", "input": "just text"})

    assert translated["messages"] == [{"role": "user", "content": "just text"}]


def test_translate_messages_body_passes_through_unchanged() -> None:
    body = {
        "model": "m",
        "messages": [{"role": "user", "content": "hi"}],
        "stream": False,
        "stream_options": {"include_usage": True},
    }

    assert translate_cursor_request(body) == body


def test_translate_missing_messages_and_input_yields_empty_messages() -> None:
    # Rejecting this shape is the route's job; the pure translation stays total.
    assert translate_cursor_request({"model": "m"})["messages"] == []


def _cursor_app(tmp_path) -> TestClient:
    config = FusionConfig(
        endpoints=[
            ModelEndpoint(id="gpt-5.5", model="gpt-5.5", base_url="http://localhost:8101"),
        ],
        default_model="gpt-5.5",
        default_mode="single",
    )
    app = create_app(
        config,
        clients={"gpt-5.5": FakeModelClient("gpt-5.5", ["hello from fake"])},
        run_store_path=tmp_path / "runs",
    )
    return TestClient(app)


def test_cursor_route_accepts_agent_mode_body_non_streaming(tmp_path) -> None:
    client = _cursor_app(tmp_path)

    response = client.post(
        "/v1/cursor/chat/completions",
        json={**AGENT_MODE_BODY, "stream": False},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["object"] == "chat.completion"
    assert body["model"] == "gpt-5.5"
    assert body["choices"][0]["message"]["content"] == "hello from fake"
    assert body["choices"][0]["finish_reason"] == "stop"


def test_cursor_route_streams_chat_completion_chunks(tmp_path) -> None:
    client = _cursor_app(tmp_path)

    response = client.post("/v1/cursor/chat/completions", json=AGENT_MODE_BODY)

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    text = response.text
    assert "chat.completion.chunk" in text
    assert text.rstrip().endswith("data: [DONE]")

    streamed = ""
    finish_reason = None
    for line in text.splitlines():
        if not line.startswith("data: ") or line == "data: [DONE]":
            continue
        chunk = json.loads(line[len("data: ") :])
        delta = chunk["choices"][0]["delta"]
        streamed += delta.get("content", "")
        if chunk["choices"][0]["finish_reason"] is not None:
            finish_reason = chunk["choices"][0]["finish_reason"]
    assert "hello from fake" in streamed
    assert finish_reason == "stop"


def test_cursor_route_plain_chat_completions_matches_v1_route(tmp_path) -> None:
    client = _cursor_app(tmp_path)
    body = {"model": "gpt-5.5", "messages": [{"role": "user", "content": "hi"}]}

    cursor_response = client.post("/v1/cursor/chat/completions", json=body)
    plain_response = client.post("/v1/chat/completions", json=body)

    assert cursor_response.status_code == plain_response.status_code == 200
    cursor_body = cursor_response.json()
    plain_body = plain_response.json()
    assert cursor_body["choices"] == plain_body["choices"]
    assert cursor_body["model"] == plain_body["model"]


def test_cursor_route_rejects_body_without_messages_or_input(tmp_path) -> None:
    client = _cursor_app(tmp_path)

    response = client.post("/v1/cursor/chat/completions", json={"model": "gpt-5.5"})

    assert response.status_code == 400
    error = response.json()["error"]
    assert error["type"] == "invalid_request_error"
    assert error["code"] == "invalid_request"
    assert "messages" in error["message"] and "input" in error["message"]


def test_cursor_route_rejects_non_json_body(tmp_path) -> None:
    client = _cursor_app(tmp_path)

    response = client.post(
        "/v1/cursor/chat/completions",
        content=b"not json",
        headers={"content-type": "application/json"},
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_json"


def test_cursor_models_mirrors_v1_models(tmp_path) -> None:
    client = _cursor_app(tmp_path)

    assert client.get("/v1/cursor/models").json() == client.get("/v1/models").json()
