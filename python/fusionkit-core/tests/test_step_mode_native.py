"""The native panel path follows the k algebra: members are single completions
(k = 1 by construction), so a tool-carrying fuse judges step proposals while
text-only fusion keeps the trajectory prompts."""

from __future__ import annotations

from fusionkit_core.clients import FakeModelClient
from fusionkit_core.config import FusionConfig
from fusionkit_core.fusion import FusionEngine
from fusionkit_core.prompts import (
    JUDGE_STEP_SYSTEM_PROMPT,
    JUDGE_SYSTEM_PROMPT,
)


def _engine() -> FusionEngine:
    config = FusionConfig(
        routekit_url="http://routekit.test",
        routekit_model_ids=["test/m1"],
        default_model="test/m1",
        default_mode="panel",
    )
    return FusionEngine(
        config, {"test/m1": FakeModelClient("test/m1", ["hello"])}
    )


def test_tool_carrying_fuse_uses_step_synthesizer() -> None:
    engine = _engine()
    tools = [{"type": "function", "function": {"name": "write_file", "parameters": {}}}]
    assert engine._fuse_synthesizer(tools) is engine.step_judge_synthesizer
    assert engine._fuse_synthesizer(tools)._judge_system == JUDGE_STEP_SYSTEM_PROMPT


def test_text_only_fuse_keeps_trajectory_synthesizer() -> None:
    engine = _engine()
    assert engine._fuse_synthesizer(None) is engine.judge_synthesizer
    assert engine._fuse_synthesizer([]) is engine.judge_synthesizer
    assert engine.judge_synthesizer._judge_system == JUDGE_SYSTEM_PROMPT
