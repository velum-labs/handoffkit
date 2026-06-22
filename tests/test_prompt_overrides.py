from __future__ import annotations

from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Any

import pytest
from fusionkit_core.config import FusionConfig, PromptOverrides, SamplingConfig
from fusionkit_core.judge import JudgeSynthesizer
from fusionkit_core.prompts import (
    AGENT_STEP_CONTRACT,
    JUDGE_SYSTEM_PROMPT,
    SYNTHESIZER_SYSTEM_PROMPT,
    SYSTEM_PROMPT_DEFAULTS,
)
from fusionkit_core.types import (
    ChatMessage,
    FusionAnalysis,
    ModelResponse,
    StreamChunk,
    Trajectory,
)


class RecordingClient:
    """A ChatClient that records the system prompts it receives."""

    def __init__(self, model_id: str, responses: Sequence[str]) -> None:
        self.model_id = model_id
        self._responses = list(responses)
        self._calls = 0
        self.system_prompts: list[str] = []

    async def chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[Mapping[str, Any]] | None = None,
        tool_choice: str | Mapping[str, Any] | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> ModelResponse:
        del sampling, tools, tool_choice, extra
        for message in messages:
            if message.role == "system":
                self.system_prompts.append(message.content)
        content = self._responses[self._calls % len(self._responses)]
        self._calls += 1
        return ModelResponse(model_id=self.model_id, content=content)

    async def stream_chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[Mapping[str, Any]] | None = None,
        tool_choice: str | Mapping[str, Any] | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> AsyncIterator[StreamChunk]:
        del sampling, tools, tool_choice, extra
        for message in messages:
            if message.role == "system":
                self.system_prompts.append(message.content)
        content = self._responses[self._calls % len(self._responses)]
        self._calls += 1
        yield StreamChunk(delta=content)

    async def aclose(self) -> None:
        return None


def _trajectory(trajectory_id: str, model_id: str, final_output: str) -> Trajectory:
    return Trajectory(
        id=trajectory_id,
        model_id=model_id,
        content=final_output,
        status="succeeded",
    )


_ANALYSIS_JSON = (
    '{"consensus":[],"contradictions":[],"unique_insights":[],'
    '"coverage_gaps":[],"likely_errors":[],"recommended_final_structure":[]}'
)


def test_prompt_overrides_default_to_none() -> None:
    config = FusionConfig.model_validate(
        {"endpoints": [{"id": "a", "model": "m", "base_url": "http://x"}], "default_model": "a"}
    )
    assert config.prompts == PromptOverrides()
    assert config.prompts.judge_system is None


def test_prompt_overrides_parsed_from_config_mapping() -> None:
    config = FusionConfig.model_validate(
        {
            "endpoints": [{"id": "a", "model": "m", "base_url": "http://x"}],
            "default_model": "a",
            "prompts": {
                "judge_system": "CUSTOM JUDGE",
                "synthesizer_system": "CUSTOM SYNTH",
            },
        }
    )
    assert config.prompts.judge_system == "CUSTOM JUDGE"
    assert config.prompts.synthesizer_system == "CUSTOM SYNTH"


@pytest.mark.asyncio
async def test_fuse_no_tools_uses_prompt_overrides() -> None:
    overrides = PromptOverrides(
        judge_system="OVERRIDE JUDGE",
        synthesizer_system="OVERRIDE SYNTH",
    )
    synthesizer = JudgeSynthesizer(overrides)
    judge = RecordingClient("judge", [_ANALYSIS_JSON])
    synth_client = RecordingClient("synth", ["the fused answer"])

    await synthesizer.fuse(
        [ChatMessage(role="user", content="Fix the bug.")],
        [_trajectory("traj_a", "alpha", "Fixed it.")],
        judge_client=judge,
        synthesizer_client=synth_client,
        sampling=SamplingConfig(),
        tools=None,
    )

    assert judge.system_prompts == ["OVERRIDE JUDGE"]
    # No tools => the synthesizer system has no agent-loop contract appended.
    assert len(synth_client.system_prompts) == 1
    assert synth_client.system_prompts[0].startswith("OVERRIDE SYNTH")
    assert AGENT_STEP_CONTRACT not in synth_client.system_prompts[0]


@pytest.mark.asyncio
async def test_fuse_with_tools_appends_agent_contract() -> None:
    synthesizer = JudgeSynthesizer(PromptOverrides(synthesizer_system="OVERRIDE SYNTH"))
    judge = RecordingClient("judge", [_ANALYSIS_JSON, "done"])

    await synthesizer.fuse(
        [ChatMessage(role="user", content="Do the thing.")],
        [_trajectory("traj_a", "alpha", "Did the thing.")],
        judge_client=judge,
        sampling=SamplingConfig(),
        tools=[{"name": "read_file", "description": "", "parameters": {}}],
    )

    # The judge gap-analysis runs first (judge system prompt), then the synthesizer
    # step (the synthesizer override + the code-side agent contract, since tools
    # are present). No separate synthesizer_client => same recording client.
    assert len(judge.system_prompts) == 2
    assert judge.system_prompts[0] == JUDGE_SYSTEM_PROMPT
    assert judge.system_prompts[1].startswith("OVERRIDE SYNTH")
    assert AGENT_STEP_CONTRACT in judge.system_prompts[1]


@pytest.mark.asyncio
async def test_fuse_reuses_passed_analysis_without_reanalyzing() -> None:
    synthesizer = JudgeSynthesizer()
    judge = RecordingClient("judge", ["done"])

    await synthesizer.fuse(
        [ChatMessage(role="user", content="Do the thing.")],
        [_trajectory("traj_a", "alpha", "Did the thing.")],
        judge_client=judge,
        sampling=SamplingConfig(),
        tools=[{"name": "read_file", "description": "", "parameters": {}}],
        analysis=FusionAnalysis(),
    )

    # A cached analysis was passed, so the judge analyze() call is skipped: the
    # only system prompt the client saw is the synthesizer step (not the judge).
    assert len(judge.system_prompts) == 1
    assert judge.system_prompts[0].startswith(SYNTHESIZER_SYSTEM_PROMPT)


@pytest.mark.asyncio
async def test_unset_overrides_fall_back_to_builtins() -> None:
    synthesizer = JudgeSynthesizer()
    judge = RecordingClient("judge", [_ANALYSIS_JSON])
    synth_client = RecordingClient("synth", ["answer"])

    await synthesizer.fuse(
        [ChatMessage(role="user", content="Fix the bug.")],
        [_trajectory("traj_a", "alpha", "Fixed it.")],
        judge_client=judge,
        synthesizer_client=synth_client,
        sampling=SamplingConfig(),
        tools=None,
    )

    assert judge.system_prompts == [JUDGE_SYSTEM_PROMPT]
    assert synth_client.system_prompts[0].startswith(SYNTHESIZER_SYSTEM_PROMPT)


def test_system_prompt_defaults_cover_every_override_id() -> None:
    assert set(SYSTEM_PROMPT_DEFAULTS) == {"judge", "synthesizer"}
    assert SYSTEM_PROMPT_DEFAULTS["judge"] == JUDGE_SYSTEM_PROMPT
    assert SYSTEM_PROMPT_DEFAULTS["synthesizer"] == SYNTHESIZER_SYSTEM_PROMPT
