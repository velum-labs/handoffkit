from __future__ import annotations

import json
from collections.abc import Sequence

from fusionkit_core.types import FusionAnalysis, Trajectory

PANEL_SYSTEM_PROMPT = """You are an independent expert panel member.
Answer the user request directly. Be explicit about assumptions, uncertainty, and evidence.
Do not mention other panel members."""

JUDGE_SYSTEM_PROMPT = """You compare candidate trajectories for a local model fusion system.
Each trajectory is one model's attempt at the request (its final answer, and where present its
reasoning, tool calls, observations, and verification result).
Return only valid JSON with these keys:
consensus, contradictions, unique_insights, coverage_gaps, likely_errors,
recommended_final_structure.
Each value must be an array of concise strings."""

SYNTHESIZER_SYSTEM_PROMPT = """You are the assistant responding directly to the user.
You are given several candidate trajectories: each is a different model's attempt at the SAME user
request (its final answer, and where present its reasoning, tool calls, observations, and result),
plus a structured judge analysis. Produce the single best final response, in first person, in the
natural shape the request calls for:
- a direct answer when the user asked a question,
- a plan when the user asked to plan,
- the concrete code change (and a short note of what you did) when the user asked to modify code.
Prefer claims supported by multiple trajectories or by clear evidence, and prefer trajectories whose
verification passed for code changes. Resolve contradictions explicitly and avoid inventing
unsupported facts. Ground the response only in what the trajectories actually observed or produced.
Do NOT describe the candidates, the trajectories, or the fusion process; just respond to the user as
the assistant."""

VERIFIER_SYSTEM_PROMPT = """You verify a fused answer against the request and candidate evidence.
Return a concise corrected answer if needed. If the answer is already sound, return it unchanged."""


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
        verification = trajectory.verification
        verification_text = "none"
        if verification is not None:
            verification_text = verification.status
            if verification.exit_code is not None:
                verification_text += f" (exit_code={verification.exit_code})"
        steps = "\n".join(_format_step(step) for step in trajectory.steps)
        sections.append(
            f"Trajectory {trajectory.id} from model {trajectory.model_id} "
            f"(status={trajectory.status}, verification={verification_text}):\n"
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
        "Compare the trajectories: which reached a correct and (where applicable) verified result, "
        "where they agree or contradict, and the likely errors. Do not write the final answer."
    )


def build_synthesis_prompt(
    user_request: str,
    trajectories: Sequence[Trajectory],
    analysis: FusionAnalysis,
) -> str:
    return (
        "Original request:\n"
        f"{user_request}\n\n"
        "Candidate trajectories:\n"
        f"{format_trajectories(trajectories)}\n\n"
        "Judge analysis JSON:\n"
        f"{json.dumps(analysis.model_dump(), indent=2)}\n\n"
        "Respond to the user now."
    )


TRAJECTORY_STEP_SYSTEM_PROMPT = """You are the assistant completing the user's request directly, \
using the tools available to you.
Several expert panels have already attempted this same request; their full agent trajectories
(reasoning, tool calls, observations, and results) are provided below as reference. Treat them as
advice from colleagues who worked in a separate scratch copy: prefer approaches whose verification
passed, reconcile their disagreements, and avoid repeating their mistakes. You are the one acting
now, in the real workspace. Take the next best concrete action toward completing the request by
calling a tool, then react to what you actually observe. When the work is complete (and, for code
changes, verified by running the project's checks), reply with the final answer and do not call a
tool. Ground every action in the real project state you observe through tools; never assume a
candidate's edits already exist here. Do not mention the panels, the candidate trajectories, or the
fusion process."""


def build_trajectory_step_system(
    trajectories: Sequence[Trajectory],
    system: str | None = None,
) -> str:
    """System prompt for the judge acting as a streaming agent on the front door.

    Injects the candidate trajectories as reference so the judge can synthesize
    its own next step (a tool call or the final answer) grounded in what the
    panel actually tried. ``system`` overrides the built-in base prompt when a
    config-supplied override is present.
    """
    base = system or TRAJECTORY_STEP_SYSTEM_PROMPT
    if not trajectories:
        return base
    return (
        f"{base}\n\n"
        "Candidate agent trajectories (reference only - produced in separate scratch copies):\n"
        f"{format_trajectories(trajectories)}"
    )


def build_verifier_prompt(
    user_request: str, answer: str, trajectories: Sequence[Trajectory]
) -> str:
    return (
        "Original request:\n"
        f"{user_request}\n\n"
        "Fused answer:\n"
        f"{answer}\n\n"
        "Candidate evidence:\n"
        f"{format_trajectories(trajectories)}\n\n"
        "Verify correctness and instruction-following."
    )


# The built-in system prompts, keyed by the stable id used for the committed
# `.fusionkit/prompts/<id>.md` override files. `fusionkit prompts dump` emits
# this map so the CLI scaffolds editable defaults that never drift from source.
SYSTEM_PROMPT_DEFAULTS: dict[str, str] = {
    "judge": JUDGE_SYSTEM_PROMPT,
    "synthesizer": SYNTHESIZER_SYSTEM_PROMPT,
    "trajectory-step": TRAJECTORY_STEP_SYSTEM_PROMPT,
    "verifier": VERIFIER_SYSTEM_PROMPT,
    "panel": PANEL_SYSTEM_PROMPT,
}
