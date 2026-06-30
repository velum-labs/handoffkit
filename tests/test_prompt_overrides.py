from __future__ import annotations

from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Any

import pytest
from fusionkit_core.config import FusionConfig, PromptOverrides, SamplingConfig
from fusionkit_core.judge import JudgeSynthesizer
from fusionkit_core.prompts import (
    AGENT_STEP_CONTRACT,
    AGENT_WORKSPACE_GROUNDING,
    FUSION_SYNTHESIZER_FRAMING,
    JUDGE_SYSTEM_PROMPT,
    SYNTHESIZER_SYSTEM_PROMPT,
    SYSTEM_PROMPT_DEFAULTS,
    FusionIdentity,
    build_fuse_system,
    build_identity_block,
    build_judge_system,
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


# --- harness-prompt pass-through + identity ---------------------------------

_HARNESS = "You are Codex, OpenAI's coding agent. Follow repository conventions."


def test_build_fuse_system_no_harness_matches_legacy_layout() -> None:
    """With no harness prompt the (overridable) synthesizer prompt is the base,
    preserving the prior standalone behavior."""
    out = build_fuse_system(
        [_trajectory("traj_a", "alpha", "Fixed it.")],
        synthesizer_system=SYNTHESIZER_SYSTEM_PROMPT,
    )
    assert out.startswith(SYNTHESIZER_SYSTEM_PROMPT)
    assert FUSION_SYNTHESIZER_FRAMING not in out


def test_build_fuse_system_harness_is_primary_with_framing_suffix() -> None:
    out = build_fuse_system(
        [_trajectory("traj_a", "alpha", "Fixed it.")],
        synthesizer_system=SYNTHESIZER_SYSTEM_PROMPT,
        harness_system=_HARNESS,
        identity=FusionIdentity(panel=("alpha",), judge="j", synthesizer="s"),
        tools_present=True,
    )
    assert out.startswith(_HARNESS)
    assert FUSION_SYNTHESIZER_FRAMING in out
    # The harness prompt supplies the loop semantics, so only the short
    # workspace-grounding note is appended (not the full standalone contract).
    assert AGENT_WORKSPACE_GROUNDING in out
    assert AGENT_STEP_CONTRACT not in out
    # The built-in synthesizer voice is dropped when the harness prompt is primary
    # and no override was supplied.
    assert SYNTHESIZER_SYSTEM_PROMPT not in out


def test_build_identity_block_lists_roles_and_disclosure_carveout() -> None:
    block = build_identity_block(
        FusionIdentity(panel=("qwen", "gemma", "codex"), judge="codex", synthesizer="codex")
    )
    assert "qwen, gemma, codex" in block
    assert "Judge (comparison/analysis): codex" in block
    assert "Synthesizer (you, writing this answer): codex" in block
    assert "what model are you" in block


def test_build_judge_system_layers_harness_then_judge() -> None:
    assert build_judge_system(JUDGE_SYSTEM_PROMPT) == JUDGE_SYSTEM_PROMPT
    layered = build_judge_system(JUDGE_SYSTEM_PROMPT, harness_system=_HARNESS)
    assert layered.startswith(_HARNESS)
    assert JUDGE_SYSTEM_PROMPT in layered


@pytest.mark.asyncio
async def test_fuse_passthrough_makes_harness_primary_and_dedupes_body() -> None:
    synthesizer = JudgeSynthesizer()  # default: pass-through on, no overrides
    judge = RecordingClient("judge-model", [_ANALYSIS_JSON])
    synth_client = RecordingClient("synth-model", ["the fused answer"])

    await synthesizer.fuse(
        [
            ChatMessage(role="system", content=_HARNESS),
            ChatMessage(role="user", content="Fix the bug."),
        ],
        [_trajectory("traj_a", "alpha", "Fixed it.")],
        judge_client=judge,
        synthesizer_client=synth_client,
        sampling=SamplingConfig(),
        tools=None,
    )

    # Exactly one system message reaches the synthesizer: the harness prompt was
    # folded into the composed system and removed from the body (not duplicated).
    assert len(synth_client.system_prompts) == 1
    composed = synth_client.system_prompts[0]
    assert composed.startswith(_HARNESS)
    assert FUSION_SYNTHESIZER_FRAMING in composed
    # Identity/disclosure block names the panel + roles.
    assert "alpha" in composed
    assert "judge-model" in composed
    assert "synth-model" in composed

    # The judge analysis used the harness prompt as its base too.
    assert len(judge.system_prompts) == 1
    assert judge.system_prompts[0].startswith(_HARNESS)
    assert JUDGE_SYSTEM_PROMPT in judge.system_prompts[0]


@pytest.mark.asyncio
async def test_fuse_passthrough_off_preserves_legacy_demotion() -> None:
    synthesizer = JudgeSynthesizer(harness_passthrough=False)
    judge = RecordingClient("judge", [_ANALYSIS_JSON])
    synth_client = RecordingClient("synth", ["answer"])

    await synthesizer.fuse(
        [
            ChatMessage(role="system", content=_HARNESS),
            ChatMessage(role="user", content="Fix the bug."),
        ],
        [_trajectory("traj_a", "alpha", "Fixed it.")],
        judge_client=judge,
        synthesizer_client=synth_client,
        sampling=SamplingConfig(),
        tools=None,
    )

    # Legacy behavior: the fusion prompt is primary and the harness system message
    # stays in the body, so the synthesizer sees two system messages.
    assert len(synth_client.system_prompts) == 2
    assert synth_client.system_prompts[0].startswith(SYNTHESIZER_SYSTEM_PROMPT)
    assert synth_client.system_prompts[1] == _HARNESS
    # The judge uses the standalone judge prompt (no harness base).
    assert judge.system_prompts == [JUDGE_SYSTEM_PROMPT]


@pytest.mark.asyncio
async def test_select_best_returns_chosen_candidate_verbatim() -> None:
    analysis = (
        '{"consensus":[],"contradictions":[],"unique_insights":[],"coverage_gaps":[],'
        '"likely_errors":[],"recommended_final_structure":[],"best_trajectory":"traj_a"}'
    )
    synthesizer = JudgeSynthesizer(select_best=True)
    judge = RecordingClient("judge", [analysis])
    synth_client = RecordingClient("synth", ["SYNTHESIZED REWRITE"])

    result = await synthesizer.fuse(
        [ChatMessage(role="user", content="Solve it.")],
        [
            _trajectory("traj_a", "alpha", "VERBATIM CANDIDATE A"),
            _trajectory("traj_b", "beta", "candidate B"),
        ],
        judge_client=judge,
        synthesizer_client=synth_client,
        sampling=SamplingConfig(),
        tools=None,
    )

    assert result.terminal
    # The judge-selected candidate is returned verbatim; the synth LLM is never called.
    assert result.response.content == "VERBATIM CANDIDATE A"
    assert synth_client.system_prompts == []
    assert result.trajectory is not None and result.trajectory.synthesis is not None
    assert result.trajectory.synthesis.decision == "select_trajectory"
    assert result.trajectory.synthesis.selected_trajectory_id == "traj_a"


@pytest.mark.asyncio
async def test_select_best_falls_back_to_synthesis_when_no_best() -> None:
    synthesizer = JudgeSynthesizer(select_best=True)
    judge = RecordingClient("judge", [_ANALYSIS_JSON])  # no best_trajectory -> compose
    synth_client = RecordingClient("synth", ["composed answer"])

    result = await synthesizer.fuse(
        [ChatMessage(role="user", content="Solve it.")],
        [_trajectory("traj_a", "alpha", "A")],
        judge_client=judge,
        synthesizer_client=synth_client,
        sampling=SamplingConfig(),
        tools=None,
    )

    assert result.response.content == "composed answer"
    assert len(synth_client.system_prompts) == 1  # synthesizer was called


@pytest.mark.asyncio
async def test_fuse_passthrough_folds_synthesizer_override_after_framing() -> None:
    synthesizer = JudgeSynthesizer(PromptOverrides(synthesizer_system="CUSTOM SYNTH VOICE"))
    judge = RecordingClient("judge", [_ANALYSIS_JSON])
    synth_client = RecordingClient("synth", ["answer"])

    await synthesizer.fuse(
        [
            ChatMessage(role="system", content=_HARNESS),
            ChatMessage(role="user", content="Fix the bug."),
        ],
        [_trajectory("traj_a", "alpha", "Fixed it.")],
        judge_client=judge,
        synthesizer_client=synth_client,
        sampling=SamplingConfig(),
        tools=None,
    )

    composed = synth_client.system_prompts[0]
    # Harness stays primary; the user override is folded in (so overrides still
    # apply) after the fusion framing.
    assert composed.startswith(_HARNESS)
    assert FUSION_SYNTHESIZER_FRAMING in composed
    assert "CUSTOM SYNTH VOICE" in composed
