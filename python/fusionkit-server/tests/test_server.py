from __future__ import annotations

import json
from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Any

from fastapi.testclient import TestClient
from fusionkit_core.clients import FakeModelClient, ProviderCallError
from fusionkit_core.config import (
    EndpointAuth,
    FusionConfig,
    FusionMode,
    ModelEndpoint,
    SamplingConfig,
)
from fusionkit_core.types import ChatMessage, ModelResponse, StreamChunk
from fusionkit_server import create_app
from fusionkit_server.app import FusionRequest


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
        # Run recording is opt-in (WS8.4); this test exercises the recorded
        # path end-to-end, including the runs API lookup below.
        headers={"x-fusionkit-record": "1"},
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


def test_chat_completions_fused_response_sums_usage_across_all_roles(tmp_path) -> None:
    # Acceptance (WS4): the plain non-streaming fused response must carry real
    # usage — the sum of every ledgered model call (panel + judge + synthesizer)
    # — instead of a fabricated null block. FakeModelClient reports
    # completion_tokens = word count and prompt_tokens = 0.
    config = FusionConfig(
        endpoints=[
            ModelEndpoint(id="m1", model="fake-m1", base_url="http://localhost:8101"),
            ModelEndpoint(id="judge", model="fake-judge", base_url="http://localhost:8201"),
        ],
        default_model="m1",
        judge_model="judge",
        synthesizer_model="judge",
        default_mode="panel",
        panel_models=["m1"],
    )
    app = create_app(
        config,
        clients={
            "m1": FakeModelClient("m1", ["candidate answer text"]),  # 3 tokens
            "judge": FakeModelClient(
                "judge",
                [
                    # Judge analysis: a single unbroken JSON token (1 token).
                    '{"consensus":["ok"],"contradictions":[],"unique_insights":[],'
                    '"coverage_gaps":[],"likely_errors":[],"recommended_final_structure":[]}',
                    "fused final answer",  # synthesizer turn: 3 tokens
                ],
            ),
        },
        run_store_path=tmp_path / "runs",
    )
    client = TestClient(app)

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "fusionkit/panel",
            "messages": [{"role": "user", "content": "compare"}],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["choices"][0]["message"]["content"] == "fused final answer"
    assert body["usage"]["prompt_tokens"] == 0
    assert body["usage"]["completion_tokens"] == 3 + 1 + 3


def _panel_app(tmp_path) -> TestClient:
    config = FusionConfig(
        endpoints=[
            ModelEndpoint(id="m1", model="fake-m1", base_url="http://localhost:8101"),
            ModelEndpoint(id="judge", model="fake-judge", base_url="http://localhost:8201"),
        ],
        default_model="m1",
        judge_model="judge",
        synthesizer_model="judge",
        default_mode="panel",
        panel_models=["m1"],
    )
    app = create_app(
        config,
        clients={
            "m1": FakeModelClient("m1", ["candidate answer"]),
            "judge": FakeModelClient(
                "judge",
                [
                    '{"consensus":["ok"],"contradictions":[],"unique_insights":[],'
                    '"coverage_gaps":[],"likely_errors":[],"recommended_final_structure":[]}',
                    "fused final answer",
                ],
            ),
        },
        run_store_path=tmp_path / "runs",
    )
    return TestClient(app)


def _fuse_payload(*, messages: list[dict[str, Any]], status: str = "succeeded") -> dict[str, Any]:
    return {
        "model": "fusionkit/panel",
        "messages": messages,
        "trajectories": [
            {
                "trajectory_id": "trajectory_1",
                "model_id": "m1",
                "status": status,
                "final_output": "candidate",
            }
        ],
    }


def test_fuse_rejects_messages_without_roles_before_model_calls(tmp_path) -> None:
    client = _panel_app(tmp_path)

    response = client.post(
        "/v1/fusion/trajectories:fuse",
        json=_fuse_payload(messages=[{"content": "silently became a user message"}]),
    )

    assert response.status_code == 422


def test_fuse_rejects_a_panel_with_no_successful_trajectory(tmp_path) -> None:
    client = _panel_app(tmp_path)

    response = client.post(
        "/v1/fusion/trajectories:fuse",
        json=_fuse_payload(
            messages=[{"role": "user", "content": "fuse this"}],
            status="failed",
        ),
    )

    assert response.status_code == 422


def test_chat_rejects_unknown_models_and_invalid_sampling_before_fanout(tmp_path) -> None:
    for body in (
        {
            "model": "totally-unknown-model",
            "messages": [{"role": "user", "content": "do not silently fuse"}],
        },
        {
            "model": "fusionkit/panel",
            "messages": [{"role": "user", "content": "negative tokens"}],
            "max_tokens": -1,
        },
        {
            "model": "fusionkit/panel",
            "messages": [{"role": "user", "content": "invalid probability"}],
            "top_p": 1.5,
        },
        {
            "model": "fusionkit/panel",
            "messages": [
                {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "call_bad",
                            "type": "function",
                            "function": {"name": "read", "arguments": '{"broken"'},
                        }
                    ],
                }
            ],
        },
    ):
        response = _panel_app(tmp_path).post("/v1/chat/completions", json=body)
        assert response.status_code in (400, 422), response.text


def test_app_shutdown_closes_every_model_client_once(tmp_path) -> None:
    class ClosableClient:
        model_id = "fast"
        max_context = None

        def __init__(self) -> None:
            self.close_calls = 0

        async def chat(
            self,
            messages: Sequence[ChatMessage],
            sampling: SamplingConfig | None = None,
            tools: Sequence[Mapping[str, Any]] | None = None,
            tool_choice: str | Mapping[str, Any] | None = None,
            extra: Mapping[str, Any] | None = None,
        ) -> ModelResponse:
            return ModelResponse(model_id=self.model_id, content="ok")

        async def stream_chat(
            self,
            messages: Sequence[ChatMessage],
            sampling: SamplingConfig | None = None,
            tools: Sequence[Mapping[str, Any]] | None = None,
            tool_choice: str | Mapping[str, Any] | None = None,
            extra: Mapping[str, Any] | None = None,
        ) -> AsyncIterator[StreamChunk]:
            yield StreamChunk(delta="ok", finish_reason="stop")

        async def aclose(self) -> None:
            self.close_calls += 1

    client = ClosableClient()
    config = FusionConfig(
        endpoints=[ModelEndpoint(id="fast", model="fake-fast")],
        default_model="fast",
        default_mode="single",
    )
    with TestClient(
        create_app(config, clients={"fast": client}, run_store_path=tmp_path / "runs")
    ):
        pass

    assert client.close_calls == 1


def test_plain_chat_completions_does_not_record_a_run(tmp_path) -> None:
    # Acceptance (WS8.4): a plain chat completion is a lightweight in-memory
    # turn — no event-sourced run machinery, no permanent run directory, no
    # fcntl file locking on the event loop. Run recording is opt-in.
    client = _panel_app(tmp_path)

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "fusionkit/panel",
            "messages": [{"role": "user", "content": "compare"}],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["choices"][0]["message"]["content"] == "fused final answer"
    runs_dir = tmp_path / "runs"
    assert not runs_dir.exists() or list(runs_dir.iterdir()) == []


def test_chat_completions_records_a_run_when_opted_in(tmp_path) -> None:
    # Acceptance (WS8.4): the x-fusionkit-record header opts back into the
    # event-sourced run path — the response carries a run id that the runs API
    # can inspect.
    client = _panel_app(tmp_path)

    response = client.post(
        "/v1/chat/completions",
        headers={"x-fusionkit-record": "1"},
        json={
            "model": "fusionkit/panel",
            "messages": [{"role": "user", "content": "compare"}],
        },
    )

    assert response.status_code == 200
    body = response.json()
    run_id = body["fusionkit"]["run_id"]
    assert run_id
    run_response = client.get(f"/v1/fusion/runs/{run_id}")
    assert run_response.status_code == 200
    assert run_response.json()["state"] == "completed"
    assert list((tmp_path / "runs").iterdir())


def test_health_serves_the_router_identity_token(tmp_path, monkeypatch) -> None:
    # Acceptance (WS9.4): the spawning CLI hashes its full effective config and
    # passes the token down; /health serves it back so a later run's
    # discover-or-spawn probe can tell a compatible router from a stale one
    # (changed model, prompt override, or API key) with the same endpoint ids.
    monkeypatch.setenv("FUSIONKIT_ROUTER_IDENTITY", "cafef00d:m1,judge")
    client = _panel_app(tmp_path)

    body = client.get("/health").json()

    assert body["status"] == "ok"
    assert body["identity"] == "cafef00d:m1,judge"


def test_health_omits_identity_when_not_spawned_by_the_cli(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.delenv("FUSIONKIT_ROUTER_IDENTITY", raising=False)
    client = _panel_app(tmp_path)

    body = client.get("/health").json()

    assert body["status"] == "ok"
    assert "identity" not in body


def test_models_endpoint_remains_openai_compatible(tmp_path) -> None:
    app = create_app(_config(), run_store_path=tmp_path / "runs")
    client = TestClient(app)

    response = client.get("/v1/models")

    assert response.status_code == 200
    body = response.json()
    assert body["object"] == "list"
    # Honesty rename (WS8.5): the keyword-matching mode is "heuristic", not
    # "router" — a real learned router is explicitly post-launch.
    assert {"id": "fusionkit/heuristic", "object": "model"} in body["data"]


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
        default_mode="heuristic",
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


def test_subscription_endpoint_is_first_class_in_unified_server(tmp_path) -> None:
    # A subscription endpoint (claude-code auth) is just another configured
    # endpoint: it appears in /v1/models and is reachable by id via passthrough.
    # The FakeModelClient stands in for the credentialed client, so no real
    # OAuth token is needed to prove the unified-endpoint wiring.
    config = FusionConfig(
        endpoints=[
            ModelEndpoint(id="fast", model="fake-fast", base_url="http://localhost:8101"),
            ModelEndpoint(
                id="claude-code-subscription",
                provider="anthropic",
                model="claude-sonnet-4-5",
                auth=EndpointAuth(mode="claude-code"),
            ),
        ],
        default_model="fast",
        default_mode="heuristic",
    )
    app = create_app(
        config,
        clients={
            "fast": FakeModelClient("fast", ["from fast"]),
            "claude-code-subscription": FakeModelClient("claude-code-subscription", ["from sub"]),
        },
        run_store_path=tmp_path / "runs",
    )
    client = TestClient(app)

    models = client.get("/v1/models").json()["data"]
    sub_entry = next(m for m in models if m["id"] == "claude-code-subscription")
    assert sub_entry["owned_by"] == "anthropic"

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "claude-code-subscription",
            "messages": [{"role": "user", "content": "hi"}],
        },
    )
    assert response.status_code == 200
    assert response.json()["choices"][0]["message"]["content"] == "from sub"


def test_chat_completions_passthrough_accepts_tool_loop_messages(tmp_path) -> None:
    # An agent tool loop sends OpenAI-nested tool_calls and null/tool-result
    # messages; the passthrough must accept them without a 422.
    config = FusionConfig(
        endpoints=[
            ModelEndpoint(id="gpt", model="fake-gpt", base_url="http://localhost:8101"),
        ],
        default_model="gpt",
        default_mode="heuristic",
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


class _RaisingClient:
    """A passthrough client whose chat raises a classified provider error."""

    def __init__(self, model_id: str, error: ProviderCallError) -> None:
        self.model_id = model_id
        self.max_context: int | None = None
        self._error = error

    async def chat(self, *args: Any, **kwargs: Any) -> Any:
        raise self._error

    def stream_chat(self, *args: Any, **kwargs: Any) -> Any:
        raise self._error

    async def aclose(self) -> None:
        return None


def test_passthrough_provider_error_surfaces_machine_readable_error_category(tmp_path) -> None:
    # A classified vendor failure on the passthrough path must carry a
    # machine-readable ``error_category`` (plus the ``category``/``code`` aliases)
    # so the Node gateway's WS5 failover can branch without re-parsing text. A
    # quota exhaustion maps to HTTP 429.
    config = FusionConfig(
        endpoints=[ModelEndpoint(id="gpt", model="fake-gpt", base_url="http://localhost:8101")],
        default_model="gpt",
        default_mode="heuristic",
    )
    error = ProviderCallError(
        "You exceeded your current quota",
        category="quota_exhausted",
        provider="openai",
        status_code=429,
        retry_after=12.0,
    )
    app = create_app(
        config,
        clients={"gpt": _RaisingClient("gpt", error)},
        run_store_path=tmp_path / "runs",
    )
    client = TestClient(app)

    response = client.post(
        "/v1/chat/completions",
        json={"model": "gpt", "messages": [{"role": "user", "content": "hi"}]},
    )

    assert response.status_code == 429
    body = response.json()["error"]
    assert body["error_category"] == "quota_exhausted"
    assert body["category"] == "quota_exhausted"
    assert body["code"] == "quota_exhausted"
    assert body["provider"] == "openai"
    assert body["retry_after"] == 12.0


def test_passthrough_auth_error_maps_to_401_with_error_category(tmp_path) -> None:
    # A permanent auth failure maps to HTTP 401 and is labelled auth_permanent so
    # the gateway fails fast rather than failing over to the ensemble.
    config = FusionConfig(
        endpoints=[ModelEndpoint(id="gpt", model="fake-gpt", base_url="http://localhost:8101")],
        default_model="gpt",
        default_mode="heuristic",
    )
    error = ProviderCallError(
        "invalid api key", category="auth_permanent", provider="openai", status_code=401
    )
    app = create_app(
        config,
        clients={"gpt": _RaisingClient("gpt", error)},
        run_store_path=tmp_path / "runs",
    )
    client = TestClient(app)

    response = client.post(
        "/v1/chat/completions",
        json={"model": "gpt", "messages": [{"role": "user", "content": "hi"}]},
    )

    assert response.status_code == 401
    assert response.json()["error"]["error_category"] == "auth_permanent"


def test_fusion_request_accepts_max_completion_tokens() -> None:
    # The Node gateway adapters emit OpenAI's modern `max_completion_tokens`
    # spelling; the router must fold it into `max_tokens` rather than silently
    # dropping the caller's output cap.
    modern = FusionRequest.model_validate(
        {
            "messages": [{"role": "user", "content": "hi"}],
            "max_completion_tokens": 321,
        }
    )
    assert modern.max_tokens == 321

    # An explicit legacy value wins over the modern spelling.
    both = FusionRequest.model_validate(
        {
            "messages": [{"role": "user", "content": "hi"}],
            "max_tokens": 100,
            "max_completion_tokens": 321,
        }
    )
    assert both.max_tokens == 100


def _config(default_mode: FusionMode = "single") -> FusionConfig:
    return FusionConfig(
        endpoints=[
            ModelEndpoint(id="fast", model="fake-fast", base_url="http://localhost:8101"),
        ],
        default_model="fast",
        default_mode=default_mode,
    )
