from __future__ import annotations

import json
from collections.abc import Sequence

from fusionkit_core.contracts import HarnessTrajectoryV1
from fusionkit_core.types import Candidate, FusionAnalysis

PANEL_SYSTEM_PROMPT = """You are an independent expert panel member.
Answer the user request directly. Be explicit about assumptions, uncertainty, and evidence.
Do not mention other panel members."""

JUDGE_SYSTEM_PROMPT = """You compare candidate answers for a local model fusion system.
Return only valid JSON with these keys:
consensus, contradictions, unique_insights, coverage_gaps, likely_errors,
recommended_final_structure.
Each value must be an array of concise strings."""

SYNTHESIZER_SYSTEM_PROMPT = """You synthesize candidate answers using a structured judge analysis.
Prefer claims supported by multiple candidates or by clear evidence.
Resolve contradictions explicitly and avoid inventing unsupported facts."""

VERIFIER_SYSTEM_PROMPT = """You verify a fused answer against the request and candidate evidence.
Return a concise corrected answer if needed. If the answer is already sound, return it unchanged."""


def format_candidates(candidates: Sequence[Candidate]) -> str:
    sections = []
    for candidate in candidates:
        sections.append(
            f"Candidate {candidate.id} from {candidate.model_id}:\n{candidate.content}"
        )
    return "\n\n---\n\n".join(sections)


def build_judge_prompt(user_request: str, candidates: Sequence[Candidate]) -> str:
    return (
        "Original request:\n"
        f"{user_request}\n\n"
        "Candidate answers:\n"
        f"{format_candidates(candidates)}\n\n"
        "Compare the candidates. Do not write the final answer."
    )


def build_synthesis_prompt(
    user_request: str,
    candidates: Sequence[Candidate],
    analysis: FusionAnalysis,
) -> str:
    return (
        "Original request:\n"
        f"{user_request}\n\n"
        "Candidate answers:\n"
        f"{format_candidates(candidates)}\n\n"
        "Judge analysis JSON:\n"
        f"{json.dumps(analysis.model_dump(), indent=2)}\n\n"
        "Write the final answer."
    )


TRAJECTORY_SYNTHESIZER_SYSTEM_PROMPT = """You are the assistant responding directly to the user.
You are given several candidate agent trajectories: each is a different model's reasoning, tool
calls, observations, and result for the SAME user request. Produce the single best final response,
in first person, in the natural shape the request calls for:
- a direct answer when the user asked a question,
- a plan when the user asked to plan,
- the concrete code change (and a short note of what you did) when the user asked to modify code.
Prefer trajectories whose verification passed for code changes. Ground the response only in what the
trajectories actually observed or produced; do not invent results. Do NOT describe the candidates,
the trajectories, or the fusion process, and do not write a third-person report. Just respond to the
user as the assistant."""


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


def format_trajectories(trajectories: Sequence[HarnessTrajectoryV1]) -> str:
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
            f"Trajectory {trajectory.trajectory_id} from model {trajectory.model_id} "
            f"(status={trajectory.status}, verification={verification_text}):\n"
            f"{steps}\n"
            f"  final_output:\n{_truncate(trajectory.final_output)}"
        )
    return "\n\n---\n\n".join(sections)


def build_trajectory_judge_prompt(
    user_request: str,
    trajectories: Sequence[HarnessTrajectoryV1],
) -> str:
    return (
        "Original request:\n"
        f"{user_request}\n\n"
        "Candidate agent trajectories (reasoning, tool calls, observations, result):\n"
        f"{format_trajectories(trajectories)}\n\n"
        "Compare the trajectories: which reached a correct and (where applicable) verified result, "
        "where they agree or contradict, and the likely errors. Do not write the final answer."
    )


def build_trajectory_synthesis_prompt(
    user_request: str,
    trajectories: Sequence[HarnessTrajectoryV1],
    analysis: FusionAnalysis,
) -> str:
    return (
        "Original request:\n"
        f"{user_request}\n\n"
        "Candidate agent trajectories:\n"
        f"{format_trajectories(trajectories)}\n\n"
        "Judge analysis JSON:\n"
        f"{json.dumps(analysis.model_dump(), indent=2)}\n\n"
        "Respond to the user now."
    )


def build_verifier_prompt(user_request: str, answer: str, candidates: Sequence[Candidate]) -> str:
    return (
        "Original request:\n"
        f"{user_request}\n\n"
        "Fused answer:\n"
        f"{answer}\n\n"
        "Candidate evidence:\n"
        f"{format_candidates(candidates)}\n\n"
        "Verify correctness and instruction-following."
    )
