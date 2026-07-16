from __future__ import annotations

from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Any

from fastapi.testclient import TestClient
from fusionkit_core.config import FusionConfig, ModelEndpoint, SamplingConfig
from fusionkit_core.types import (
    ChatMessage,
    ModelResponse,
    ProviderCost,
    StreamChunk,
    Usage,
)
from fusionkit_server import create_app

REQUEST_CONTROLS = {
    "provider": {
        "order": ["FirstParty"],
        "allow_fallbacks": False,
    },
    "reasoning": {"effort": "high"},
    "usage": {"include": True},
}


class RecordingClient:
    max_context: int | None = None

    def __init__(
        self,
        model_id: str,
        responses: Sequence[ModelResponse],
        *,
        stream_chunks: Sequence[StreamChunk] = (),
    ) -> None:
        self.model_id = model_id
        self._responses = list(responses)
        self._stream_chunks = list(stream_chunks)
        self.calls: list[dict[str, Any]] = []

    async def chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[Mapping[str, Any]] | None = None,
        tool_choice: str | Mapping[str, Any] | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> ModelResponse:
        self.calls.append(
            {
                "kind": "chat",
                "sampling": sampling,
                "tools": tools,
                "tool_choice": tool_choice,
                "extra": dict(extra or {}),
                "messages": list(messages),
            }
        )
        if not self._responses:
            raise AssertionError(f"unexpected chat call to {self.model_id}")
        return self._responses.pop(0)

    async def stream_chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[Mapping[str, Any]] | None = None,
        tool_choice: str | Mapping[str, Any] | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> AsyncIterator[StreamChunk]:
        self.calls.append(
            {
                "kind": "stream",
                "sampling": sampling,
                "tools": tools,
                "tool_choice": tool_choice,
                "extra": dict(extra or {}),
                "messages": list(messages),
            }
        )
        for chunk in self._stream_chunks:
            yield chunk

    async def aclose(self) -> None:
        return None


def _cost(amount: float, generation_id: str) -> ProviderCost:
    return ProviderCost(
        source="provider",
        cost_usd=amount,
        generation_id=generation_id,
        lookup_status="complete",
    )


def _analysis_response() -> ModelResponse:
    return ModelResponse(
        model_id="judge",
        content=(
            '{"consensus":["candidate is usable"],"contradictions":[],'
            '"unique_insights":[],"coverage_gaps":[],"likely_errors":[],'
            '"recommended_final_structure":["return it"]}'
        ),
        usage=Usage(prompt_tokens=2, completion_tokens=3, total_tokens=5),
        provider_cost=_cost(0.2, "judge-call"),
    )


def _synthesis_response() -> ModelResponse:
    return ModelResponse(
        model_id="judge",
        content="fused answer",
        finish_reason="stop",
        usage=Usage(prompt_tokens=4, completion_tokens=5, total_tokens=9),
        provider_cost=_cost(0.3, "synth-call"),
    )


def _config() -> FusionConfig:
    return FusionConfig(
        endpoints=[
            ModelEndpoint(id="member", provider="openrouter", model="open/member"),
            ModelEndpoint(id="judge", provider="openrouter", model="open/judge"),
        ],
        default_model="member",
        default_mode="panel",
        panel_models=["member"],
        judge_model="judge",
        synthesizer_model="judge",
    )


def _panel_response() -> ModelResponse:
    return ModelResponse(
        model_id="member",
        content="candidate answer",
        finish_reason="stop",
        usage=Usage(prompt_tokens=1, completion_tokens=2, total_tokens=3),
        provider_cost=_cost(1.0, "panel-call"),
        raw={
            "id": "provider-response-id",
            "model": "effective/member",
            "provider": "FirstParty",
            "opaque": "must-not-be-inlined",
        },
    )


def _assert_controls(calls: Sequence[dict[str, Any]]) -> None:
    assert calls
    for call in calls:
        for key, value in REQUEST_CONTROLS.items():
            assert call["extra"][key] == value


def test_panel_controls_evidence_and_compound_cost_are_preserved(tmp_path) -> None:
    member = RecordingClient("member", [_panel_response()])
    judge = RecordingClient("judge", [_analysis_response(), _synthesis_response()])
    app = create_app(
        _config(),
        clients={"member": member, "judge": judge},
        run_store_path=tmp_path / "runs",
    )

    response = TestClient(app).post(
        "/v1/chat/completions",
        json={
            "model": "fusionkit/panel",
            "messages": [{"role": "user", "content": "solve"}],
            **REQUEST_CONTROLS,
            "fusion": {"include_evidence": True},
        },
    )

    assert response.status_code == 200
    _assert_controls(member.calls)
    _assert_controls(judge.calls)
    body = response.json()
    assert body["provider_cost"]["cost_usd"] == 1.5
    assert body["usage"]["total_tokens"] == 3 + 5 + 9
    evidence = body["fusion"]["input_trajectories"]
    assert len(evidence) == 1
    assert evidence[0]["final_output"] == "candidate answer"
    assert evidence[0]["metadata"]["response"] == {
        "id": "provider-response-id",
        "model": "effective/member",
        "provider": "FirstParty",
    }
    assert "raw_response" not in evidence[0]["metadata"]
    assert "opaque" not in evidence[0]["metadata"]["response"]


def test_trajectory_fuse_filters_failures_and_reports_stage_cost_only(tmp_path) -> None:
    judge = RecordingClient("judge", [_analysis_response(), _synthesis_response()])
    app = create_app(
        _config(),
        clients={
            "member": RecordingClient("member", []),
            "judge": judge,
        },
        run_store_path=tmp_path / "runs",
    )

    response = TestClient(app).post(
        "/v1/fusion/trajectories:fuse",
        json={
            "model": "fusionkit/panel",
            "messages": [{"role": "user", "content": "fuse"}],
            "include_evidence": True,
            "temperature": 0.6,
            "top_p": 0.9,
            "max_completion_tokens": 4096,
            "seed": 7,
            **REQUEST_CONTROLS,
            "trajectories": [
                {
                    "trajectory_id": "ok",
                    "model_id": "member",
                    "status": "succeeded",
                    "final_output": "candidate",
                    "metadata": {
                        "provider_cost": {
                            "source": "provider",
                            "cost_usd": 1.0,
                            "generation_id": "external-panel",
                        }
                    },
                },
                {
                    "trajectory_id": "failed",
                    "model_id": "other",
                    "status": "failed",
                    "final_output": "",
                    "metadata": {"error_code": "provider_timeout"},
                },
            ],
        },
    )

    assert response.status_code == 200
    _assert_controls(judge.calls)
    assert [call["sampling"].temperature for call in judge.calls] == [0.0, 0.6]
    assert all(call["sampling"].top_p == 0.9 for call in judge.calls)
    assert all(call["sampling"].max_tokens == 4096 for call in judge.calls)
    assert all(call["sampling"].seed == 7 for call in judge.calls)
    body = response.json()
    assert body["provider_cost"]["cost_usd"] == 0.5
    assert body["usage"]["total_tokens"] == 5 + 9
    assert [
        trajectory["trajectory_id"]
        for trajectory in body["fusion"]["input_trajectories"]
    ] == ["ok", "failed"]
    judge_prompt = judge.calls[0]["messages"][-1].content
    assert "candidate" in judge_prompt
    assert "provider_timeout" not in judge_prompt


def test_passthrough_and_streaming_panel_forward_request_controls(tmp_path) -> None:
    passthrough_member = RecordingClient("member", [_panel_response()])
    passthrough_judge = RecordingClient("judge", [])
    passthrough_app = create_app(
        _config(),
        clients={"member": passthrough_member, "judge": passthrough_judge},
        run_store_path=tmp_path / "passthrough-runs",
    )
    passthrough = TestClient(passthrough_app).post(
        "/v1/chat/completions",
        json={
            "model": "member",
            "messages": [{"role": "user", "content": "solve"}],
            **REQUEST_CONTROLS,
        },
    )

    assert passthrough.status_code == 200
    _assert_controls(passthrough_member.calls)

    member = RecordingClient("member", [_panel_response()])
    judge = RecordingClient(
        "judge",
        [_analysis_response()],
        stream_chunks=[
            StreamChunk(delta="fused "),
            StreamChunk(
                delta="stream",
                finish_reason="stop",
                usage=Usage(prompt_tokens=4, completion_tokens=2, total_tokens=6),
                provider_cost=_cost(0.3, "stream-synth"),
            ),
        ],
    )
    stream_app = create_app(
        _config(),
        clients={"member": member, "judge": judge},
        run_store_path=tmp_path / "stream-runs",
    )
    streamed = TestClient(stream_app).post(
        "/v1/chat/completions",
        json={
            "model": "fusionkit/panel",
            "messages": [{"role": "user", "content": "solve"}],
            "stream": True,
            **REQUEST_CONTROLS,
        },
    )

    assert streamed.status_code == 200
    _assert_controls(member.calls)
    _assert_controls(judge.calls)
    assert any(call["kind"] == "stream" for call in judge.calls)


def test_recorded_run_rejects_unpersisted_provider_controls(tmp_path) -> None:
    app = create_app(
        _config(),
        clients={
            "member": RecordingClient("member", []),
            "judge": RecordingClient("judge", []),
        },
        run_store_path=tmp_path / "runs",
    )

    response = TestClient(app).post(
        "/v1/chat/completions",
        headers={"x-fusionkit-record": "1"},
        json={
            "model": "fusionkit/panel",
            "messages": [{"role": "user", "content": "solve"}],
            **REQUEST_CONTROLS,
        },
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "unsupported_recorded_request_controls"
