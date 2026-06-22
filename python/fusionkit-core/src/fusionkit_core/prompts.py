from __future__ import annotations

import json
from collections.abc import Sequence

from fusionkit_core.types import FusionAnalysis, Trajectory

JUDGE_SYSTEM_PROMPT = """You compare candidate trajectories for a local model fusion system.
Each trajectory is one model's attempt at the request (its final answer, and where present its
reasoning, tool calls, and observations).
Return only valid JSON with these keys:
consensus, contradictions, unique_insights, coverage_gaps, likely_errors,
recommended_final_structure.
Each value must be an array of concise strings."""

SYNTHESIZER_SYSTEM_PROMPT = """You are the assistant responding directly to the user.
You are given several candidate trajectories: each is a different model's attempt at the SAME user
request (its final answer, and where present its reasoning, tool calls, and observations), plus a
structured judge analysis. Respond as the assistant in the natural shape the request calls for - a
direct answer when the user asked a question, a plan when they asked to plan, or the concrete code
change when they asked to modify code - either directly, or by taking the next concrete action with
the tools available to you.
Prefer claims supported by multiple trajectories or by clear evidence. Resolve contradictions
explicitly and avoid inventing unsupported facts. Ground the response only in what the trajectories
actually observed or produced and in the real state you observe. Do NOT describe the candidates, the
trajectories, or the fusion process; just respond to the user as the assistant."""

# Fixed agent-loop contract appended to the synthesizer system prompt only when
# tools are present. This is mechanism (loop semantics + workspace-grounding
# safety), not a user-editable prompt: the candidate trajectories were produced
# in isolated worktrees, so the synthesizer acting in the real workspace must
# never assume their edits already exist here.
AGENT_STEP_CONTRACT = """You have tools available and are acting now in the real workspace.
Take the next best concrete action toward completing the request by calling a tool, then react to
what you actually observe. When the work is complete, reply with the final answer and do not call a
tool. Ground every action in the real project state you observe through tools; never assume a
candidate's edits already exist here - the candidate trajectories were produced in separate scratch
copies."""


def _truncate(text: str, limit: int = 1200) -> str:
    text = text or ""
    return text if len(text) <= limit else text[:limit] + "...[truncated]"


def _format_step(step: object) -> str:
    step_type = getattr(step, "type", "")
    text = _truncate(getattr(step, "text", "") or "", 600)
    if step_type == "tool_call":
        tool = getattr(step, "tool_name", "") or "tool"
        tool_input = _truncate(getattr(step, "tool_input", "") or "", 300)
        return f"  [tool_call] {tool} {tool_input}".rstrip()
    if step_type == "observation":
        return f"  [observation] {text}".rstrip()
    if step_type == "reasoning":
        return f"  [reasoning] {text}".rstrip()
    return f"  [output] {text}".rstrip()


def format_trajectories(trajectories: Sequence[Trajectory]) -> str:
    sections = []
    for trajectory in trajectories:
        steps = "\n".join(_format_step(step) for step in trajectory.steps)
        sections.append(
            f"Trajectory {trajectory.id} from model {trajectory.model_id} "
            f"(status={trajectory.status}):\n"
            f"{steps}\n"
            f"  final_output:\n{_truncate(trajectory.content)}"
        )
    return "\n\n---\n\n".join(sections)


def build_judge_prompt(user_request: str, trajectories: Sequence[Trajectory]) -> str:
    return (
        "Original request:\n"
        f"{user_request}\n\n"
        "Candidate trajectories (final answer, and where present reasoning, tool calls, "
        "observations, result):\n"
        f"{format_trajectories(trajectories)}\n\n"
        "Compare the trajectories: which reached a correct result, where they agree or contradict, "
        "and the likely errors. Do not write the final answer."
    )


def build_fuse_system(
    trajectories: Sequence[Trajectory],
    *,
    synthesizer_system: str,
    analysis: FusionAnalysis | None = None,
    tools_present: bool = False,
) -> str:
    """System prompt for the synthesizer producing the fused output.

    The synthesizer prompt is the role/voice. When tools are present the fixed
    :data:`AGENT_STEP_CONTRACT` (next-step loop semantics + workspace grounding)
    is appended - mechanism, not a user-editable prompt. The candidate
    trajectories and, when available, the judge's gap analysis are injected as
    reference so the synthesizer grounds its output in what the panel tried.

    With no tools the synthesizer produces the final answer in one shot (the old
    text-fusion ``synthesize``); with tools it takes the next step and the harness
    drives the loop. ``synthesizer_system`` is the (possibly overridden) base.
    """
    sections = [synthesizer_system]
    if tools_present:
        sections.append(AGENT_STEP_CONTRACT)
    if trajectories:
        sections.append(
            "Candidate agent trajectories (reference only - produced in separate scratch copies):\n"
            f"{format_trajectories(trajectories)}"
        )
        if analysis is not None:
            sections.append(
                "Judge analysis JSON (gaps, consensus, and where the union beats each candidate):\n"
                f"{json.dumps(analysis.model_dump(), indent=2)}"
            )
    return "\n\n".join(sections)


# The built-in system prompts, keyed by the stable id used for the committed
# `.fusionkit/prompts/<id>.md` override files. `fusionkit prompts dump` emits
# this map so the CLI scaffolds editable defaults that never drift from source.
# Only two roles: the judge (compare) and the synthesizer (produce the output).
# The agent-loop contract is code-side (AGENT_STEP_CONTRACT), not an override id.
SYSTEM_PROMPT_DEFAULTS: dict[str, str] = {
    "judge": JUDGE_SYSTEM_PROMPT,
    "synthesizer": SYNTHESIZER_SYSTEM_PROMPT,
}
