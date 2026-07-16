from __future__ import annotations

from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Any

from fastapi.testclient import TestClient
from fusionkit_core.config import FusionConfig, SamplingConfig
from fusionkit_core.types import ChatMessage, ModelResponse, StreamChunk, Usage
from fusionkit_server import create_app
from fusionkit_server.app import FuseTrajectoriesRequest

REQUEST_CONTROLS = {
    "provider": {"order": ["FirstParty"], "allow_fallbacks": False},
    "reasoning": {"effort": "high"},
    "usage": {"include": True},
    "parallel_tool_calls": False,
}


class RecordingClient:
    max_context: int | None = None

    def __init__(
        self,
        model_id: str,
        responses: Sequence[ModelResponse],
    ) -> None:
        self.model_id = model_id
        self._responses = list(responses)
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
        del messages, sampling, tools, tool_choice, extra
        if False:
            yield StreamChunk()

    async def aclose(self) -> None:
        return None


def _config() -> FusionConfig:
    return FusionConfig(
        routekit_url="http://routekit.test",
        endpoint_ids=["member", "judge"],
        default_model="member",
        default_mode="panel",
        panel_models=["member"],
        judge_model="judge",
        synthesizer_model="judge",
    )


def _analysis_response() -> ModelResponse:
    return ModelResponse(
        model_id="judge",
        content=(
            '{"consensus":["candidate is usable"],"contradictions":[],'
            '"unique_insights":[],"coverage_gaps":[],"likely_errors":[],'
            '"recommended_final_structure":["return it"],'
            '"best_trajectory":"ok"}'
        ),
        usage=Usage(prompt_tokens=2, completion_tokens=3, total_tokens=5),
    )


def _synthesis_response() -> ModelResponse:
    return ModelResponse(
        model_id="judge",
        content="fused answer",
        finish_reason="stop",
        usage=Usage(prompt_tokens=4, completion_tokens=5, total_tokens=9),
    )


def test_trajectory_fuse_preserves_controls_sampling_and_all_evidence(tmp_path) -> None:
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
            "model": "fusion-panel",
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
                    "end_reason": {"kind": "completed"},
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
    assert [call["sampling"].temperature for call in judge.calls] == [0.0, 0.6]
    assert all(call["sampling"].top_p == 0.9 for call in judge.calls)
    assert all(call["sampling"].max_tokens == 4096 for call in judge.calls)
    assert all(call["sampling"].seed == 7 for call in judge.calls)
    assert all(call["extra"] == REQUEST_CONTROLS for call in judge.calls)

    body = response.json()
    assert body["usage"]["total_tokens"] == 14
    assert [
        trajectory["trajectory_id"]
        for trajectory in body["fusion"]["input_trajectories"]
    ] == ["ok", "failed"]
    assert body["fusion"]["input_trajectories"][0]["metadata"]["end_reason"] == {
        "kind": "completed"
    }
    judge_prompt = judge.calls[0]["messages"][-1].content
    assert "candidate" in judge_prompt
    assert "provider_timeout" not in judge_prompt


def test_trajectory_request_rejects_conflicting_token_aliases() -> None:
    payload = {
        "messages": [{"role": "user", "content": "fuse"}],
        "trajectories": [
            {
                "trajectory_id": "ok",
                "model_id": "member",
                "status": "succeeded",
                "final_output": "candidate",
            }
        ],
    }

    request = FuseTrajectoriesRequest.model_validate(
        {**payload, "max_tokens": 321, "max_completion_tokens": 321}
    )
    assert request.max_tokens == 321

    try:
        FuseTrajectoriesRequest.model_validate(
            {**payload, "max_tokens": 100, "max_completion_tokens": 321}
        )
    except ValueError:
        pass
    else:
        raise AssertionError("conflicting token aliases must fail")
