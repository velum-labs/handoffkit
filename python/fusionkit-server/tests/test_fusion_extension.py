"""The ``fusion`` extension on fuse responses: terminal steps carry the fused
trajectory + synthesis; non-terminal steps carry the judge's adopted candidate
(``analysis.best_trajectory``) so the gateway can attribute the adopted
proposal between rounds."""

from __future__ import annotations

from fusionkit_core.judge import FuseResult
from fusionkit_core.types import FusionAnalysis, ModelResponse, ToolCall, Trajectory
from fusionkit_server.app import _fusion_extension


def _step_response() -> ModelResponse:
    return ModelResponse(
        model_id="judge",
        content="",
        finish_reason="tool_calls",
        tool_calls=[ToolCall(id="c1", name="write_file", arguments="{}")],
    )


def test_non_terminal_step_carries_best_trajectory() -> None:
    result = FuseResult(
        response=_step_response(),
        terminal=False,
        analysis=FusionAnalysis(best_trajectory="panels_s_t1_kimi_0"),
        trajectory=None,
    )
    assert _fusion_extension(result) == {
        "analysis": {"best_trajectory": "panels_s_t1_kimi_0"}
    }


def test_non_terminal_step_without_best_trajectory_has_no_extension() -> None:
    result = FuseResult(
        response=_step_response(),
        terminal=False,
        analysis=FusionAnalysis(),
        trajectory=None,
    )
    assert _fusion_extension(result) is None


def test_evidence_extension_retains_failed_and_successful_candidates() -> None:
    result = FuseResult(
        response=_step_response(),
        terminal=False,
        analysis=FusionAnalysis(),
        trajectory=None,
        input_trajectories=[
            Trajectory(
                id="ok",
                model_id="member",
                content="complete candidate",
                status="succeeded",
                metadata={
                    "raw_response": {
                        "id": "response-id",
                        "model": "effective-model",
                        "provider": "first-party",
                        "secret": "not-on-wire",
                    }
                },
            ),
            Trajectory(
                id="failed",
                model_id="other",
                content="",
                status="failed",
                metadata={"error_code": "timeout"},
            ),
        ],
    )

    extension = _fusion_extension(result, include_evidence=True)
    assert extension is not None
    assert extension["evidence_schema"] == "fusionkit.input-trajectories.v1"
    assert [item["trajectory_id"] for item in extension["input_trajectories"]] == [
        "ok",
        "failed",
    ]
    assert extension["input_trajectories"][0]["metadata"]["response"] == {
        "id": "response-id",
        "model": "effective-model",
        "provider": "first-party",
    }
