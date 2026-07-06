"""Step-mode (finite-k) fusion: prompt selection by ``panel_mode`` and the
proposal parity fix that keeps member tool_calls as ``function_call`` items."""

from __future__ import annotations

from fusionkit_core.config import PromptOverrides
from fusionkit_core.judge import JudgeSynthesizer
from fusionkit_core.producers import trajectory_from_response
from fusionkit_core.prompts import (
    JUDGE_STEP_SYSTEM_PROMPT,
    JUDGE_SYSTEM_PROMPT,
    SYNTHESIZER_STEP_SYSTEM_PROMPT,
    SYNTHESIZER_SYSTEM_PROMPT,
)
from fusionkit_core.types import ModelResponse, ToolCall


def test_step_mode_selects_step_prompts() -> None:
    step = JudgeSynthesizer(panel_mode="step")
    assert step._judge_system == JUDGE_STEP_SYSTEM_PROMPT
    assert step._synthesizer_system == SYNTHESIZER_STEP_SYSTEM_PROMPT


def test_trajectory_mode_keeps_default_prompts() -> None:
    default = JudgeSynthesizer()
    assert default._judge_system == JUDGE_SYSTEM_PROMPT
    assert default._synthesizer_system == SYNTHESIZER_SYSTEM_PROMPT


def test_committed_overrides_win_over_step_defaults() -> None:
    overridden = JudgeSynthesizer(
        PromptOverrides(judge_system="my judge", synthesizer_system="my synth"),
        panel_mode="step",
    )
    assert overridden._judge_system == "my judge"
    assert overridden._synthesizer_system == "my synth"


def test_step_prompts_state_the_adoption_contract() -> None:
    # The load-bearing rules of B10/B16b must survive prompt edits.
    assert "verbatim" in SYNTHESIZER_STEP_SYSTEM_PROMPT
    assert "ONE candidate" in SYNTHESIZER_STEP_SYSTEM_PROMPT
    assert "Never merge tool calls across candidates" in SYNTHESIZER_STEP_SYSTEM_PROMPT
    assert "never happened in the real" in SYNTHESIZER_STEP_SYSTEM_PROMPT
    assert "NEXT-STEP proposals" in JUDGE_STEP_SYSTEM_PROMPT


def test_trajectory_from_response_keeps_tool_calls_as_proposals() -> None:
    response = ModelResponse(
        model_id="alpha",
        content="let me edit",
        finish_reason="tool_calls",
        tool_calls=[
            ToolCall(id="c1", name="write_file", arguments='{"path": "a.py"}'),
            ToolCall(id="c2", name="run", arguments='{"command": "pytest"}'),
        ],
    )
    trajectory = trajectory_from_response("alpha", response)
    calls = [item for item in trajectory.items if item.type == "function_call"]
    assert [(item.call_id, item.name, item.arguments) for item in calls] == [
        ("c1", "write_file", '{"path": "a.py"}'),
        ("c2", "run", '{"command": "pytest"}'),
    ]
    assert trajectory.content == "let me edit"


def test_trajectory_from_response_without_tool_calls_is_unchanged() -> None:
    response = ModelResponse(model_id="alpha", content="an answer", finish_reason="stop")
    trajectory = trajectory_from_response("alpha", response)
    assert trajectory.items == []
    assert trajectory.content == "an answer"
