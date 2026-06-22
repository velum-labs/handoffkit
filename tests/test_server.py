from __future__ import annotations

import json

from fastapi.testclient import TestClient
from fusionkit_core.clients import FakeModelClient
from fusionkit_core.config import FusionConfig, FusionMode, ModelEndpoint
from fusionkit_server import create_app


def test_chat_completions_single_mode(tmp_path) -> None:
    config = FusionConfig(
        endpoints=[
            ModelEndpoint(id="fast", model="fake-fast", base_url="http://localhost:8101"),
        ],
        default_model="fast",
        default_mode="single",
    )
    app = create_app(
        config,
        clients={"fast": FakeModelClient("fast", ["hello from fake"])},
        run_store_path=tmp_path / "runs",
    )
    client = TestClient(app)

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "fusionkit/single",
            "messages": [{"role": "user", "content": "hello"}],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["choices"][0]["message"]["content"] == "hello from fake"
    assert body["fusionkit"]["trajectory_count"] == 1
    assert body["fusionkit"]["run_id"]
    assert body["fusionkit"]["trace_id"]
    assert body["fusionkit"]["state"] == "completed"
    assert "inspection" not in body["fusionkit"]
    assert "artifacts" not in body["fusionkit"]

    run_response = client.get(f"/v1/fusion/runs/{body['fusionkit']['run_id']}")
    assert run_response.status_code == 200
    assert run_response.json()["state"] == "completed"


def test_models_endpoint_remains_openai_compatible(tmp_path) -> None:
    app = create_app(_config(), run_store_path=tmp_path / "runs")
    client = TestClient(app)

    response = client.get("/v1/models")

    assert response.status_code == 200
    body = response.json()
    assert body["object"] == "list"
    assert {"id": "fusionkit/router", "object": "model"} in body["data"]


def test_chat_completions_streaming_returns_sse_chunks(tmp_path) -> None:
    app = create_app(
        _config(default_mode="single"),
        clients={"fast": FakeModelClient("fast", ["hello from fused stream"])},
        run_store_path=tmp_path / "runs",
    )
    client = TestClient(app)

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "fusionkit/single",
            "messages": [{"role": "user", "content": "hello"}],
            "stream": True,
        },
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    body = response.text
    assert "chat.completion.chunk" in body
    assert body.rstrip().endswith("data: [DONE]")

    streamed_content = ""
    final_finish_reason = None
    for line in body.splitlines():
        if not line.startswith("data: ") or line == "data: [DONE]":
            continue
        chunk = json.loads(line[len("data: ") :])
        delta = chunk["choices"][0]["delta"]
        streamed_content += delta.get("content", "")
        if chunk["choices"][0]["finish_reason"] is not None:
            final_finish_reason = chunk["choices"][0]["finish_reason"]
    assert streamed_content
    assert final_finish_reason == "stop"


def test_chat_completions_rejects_invalid_fusion_mode(tmp_path) -> None:
    config = FusionConfig(
        endpoints=[
            ModelEndpoint(id="fast", model="fake-fast", base_url="http://localhost:8101"),
        ],
        default_model="fast",
        default_mode="single",
    )
    app = create_app(
        config,
        clients={"fast": FakeModelClient("fast", ["hello from fake"])},
        run_store_path=tmp_path / "runs",
    )
    client = TestClient(app)

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "fusionkit/single",
            "messages": [{"role": "user", "content": "hello"}],
            "fusion": {"mode": "unknown"},
        },
    )

    assert response.status_code == 422


def test_chat_completions_preserves_self_fusion_sample_count(tmp_path) -> None:
    config = _config(default_mode="self")
    app = create_app(
        config,
        clients={"fast": FakeModelClient("fast")},
        run_store_path=tmp_path / "runs",
    )
    client = TestClient(app)

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "fusionkit/self",
            "messages": [{"role": "user", "content": "hello"}],
            "fusion": {"mode": "self", "sample_count": 2},
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["fusionkit"]["trajectory_count"] == 2


def test_chat_completions_passthrough_by_endpoint_id(tmp_path) -> None:
    # When `model` names a configured endpoint, the request bypasses fusion and
    # calls that model directly (the multi-model analogue of `serve-endpoint`).
    config = FusionConfig(
        endpoints=[
            ModelEndpoint(id="gpt", model="fake-gpt", base_url="http://localhost:8101"),
            ModelEndpoint(id="sonnet", model="fake-sonnet", base_url="http://localhost:8102"),
        ],
        default_model="gpt",
        default_mode="router",
    )
    app = create_app(
        config,
        clients={
            "gpt": FakeModelClient("gpt", ["from gpt"]),
            "sonnet": FakeModelClient("sonnet", ["from sonnet"]),
        },
        run_store_path=tmp_path / "runs",
    )
    client = TestClient(app)

    response = client.post(
        "/v1/chat/completions",
        json={"model": "sonnet", "messages": [{"role": "user", "content": "hi"}]},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["model"] == "sonnet"
    assert body["choices"][0]["message"]["content"] == "from sonnet"
    # Passthrough does not run a fusion job, so there is no fusion metadata block.
    assert "fusionkit" not in body


def test_chat_completions_passthrough_accepts_tool_loop_messages(tmp_path) -> None:
    # An agent tool loop sends OpenAI-nested tool_calls and null/tool-result
    # messages; the passthrough must accept them without a 422.
    config = FusionConfig(
        endpoints=[
            ModelEndpoint(id="gpt", model="fake-gpt", base_url="http://localhost:8101"),
        ],
        default_model="gpt",
        default_mode="router",
    )
    app = create_app(
        config,
        clients={"gpt": FakeModelClient("gpt", ["done"])},
        run_store_path=tmp_path / "runs",
    )
    client = TestClient(app)

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "gpt",
            "messages": [
                {"role": "user", "content": "edit the file"},
                {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "type": "function",
                            "function": {"name": "write_file", "arguments": "{}"},
                        }
                    ],
                },
                {"role": "tool", "tool_call_id": "call_1", "content": "ok"},
            ],
            "tools": [
                {
                    "type": "function",
                    "function": {"name": "write_file", "description": "", "parameters": {}},
                }
            ],
        },
    )

    assert response.status_code == 200
    assert response.json()["choices"][0]["message"]["content"] == "done"


def _config(default_mode: FusionMode = "single") -> FusionConfig:
    return FusionConfig(
        endpoints=[
            ModelEndpoint(id="fast", model="fake-fast", base_url="http://localhost:8101"),
        ],
        default_model="fast",
        default_mode=default_mode,
    )
