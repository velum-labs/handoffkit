from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass, field

from fusionkit_core.types import FusionAnalysis, Trajectory


@dataclass(frozen=True)
class FusionIdentity:
    """Factual description of the roles in a fusion run, for prompt disclosure.

    ``panel`` are the panel member endpoint ids (the independent candidates),
    ``judge``/``synthesizer`` the endpoint ids of those roles, and
    ``self_id``/``self_ordinal`` identify *this* role when it is a single panel
    member (1-based ``self_ordinal`` of ``len(panel)`` peers). All fields are
    optional so the block degrades gracefully when a role is unknown.
    """

    panel: tuple[str, ...] = field(default_factory=tuple)
    judge: str | None = None
    synthesizer: str | None = None
    self_id: str | None = None
    self_ordinal: int | None = None


JUDGE_SYSTEM_PROMPT = """You compare candidate trajectories for a local model fusion system.
Each trajectory is one model's attempt at the request (its final answer, and where present its
reasoning, tool calls, and observations).
Return only valid JSON with these keys:
consensus, contradictions, unique_insights, coverage_gaps, likely_errors,
recommended_final_structure, best_trajectory.
Each of the first six values must be an array of concise strings. ``best_trajectory`` is the id
string (as labeled "Trajectory <id> from model ...") of the single candidate that is the most
complete and most likely-correct answer to return as-is - or null if no single candidate is
clearly best and the answer should be composed from several."""

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

# Fusion framing appended *after* the coding-harness system prompt when it is
# passed through as the primary base (so the synthesizer keeps the harness's own
# SOTA agent prompt and conventions, and the fusion mechanics ride on top as a
# subordinate suffix). Used in place of SYNTHESIZER_SYSTEM_PROMPT's "you are the
# assistant" voice, which the harness prompt already establishes.
FUSION_SYNTHESIZER_FRAMING = (
    "In addition to all instructions above, you are the synthesizer in a FusionKit ensemble. "
    "You are given several candidate attempts at this SAME request from a panel of models, plus a "
    "structured judge analysis. Honor every instruction above; use the candidates only as "
    "reference to produce the best response or next action in the natural shape the request asks. "
    "Prefer claims supported by multiple candidates or by clear evidence, and resolve "
    "contradictions explicitly. Do NOT narrate the fusion process or describe the candidate "
    "trajectories as part of your answer; just respond as the assistant."
)

# The single fact the harness prompt cannot know, appended when tools are present
# and the harness prompt is the base (the harness prompt already supplies the
# tool-loop semantics that AGENT_STEP_CONTRACT spells out for the standalone case).
AGENT_WORKSPACE_GROUNDING = (
    "You are acting now in the real workspace. Ground every action in the real project state you "
    "observe through tools; never assume a candidate's edits already exist here - the candidate "
    "trajectories were produced in separate scratch copies."
)


def _truncate(text: str, limit: int = 1200) -> str:
    text = text or ""
    return text if len(text) <= limit else text[:limit] + "...[truncated]"


def _format_item(item: object) -> str:
    item_type = getattr(item, "type", "")
    text = _truncate(getattr(item, "text", "") or "", 600)
    if item_type == "function_call":
        tool = getattr(item, "name", "") or "tool"
        arguments = _truncate(getattr(item, "arguments", "") or "", 300)
        return f"  [function_call] {tool} {arguments}".rstrip()
    if item_type == "function_call_output":
        return f"  [function_call_output] {text}".rstrip()
    if item_type == "reasoning":
        return f"  [reasoning] {text}".rstrip()
    return f"  [message] {text}".rstrip()


def format_trajectories(trajectories: Sequence[Trajectory]) -> str:
    sections = []
    for trajectory in trajectories:
        items = "\n".join(_format_item(item) for item in trajectory.items)
        sections.append(
            f"Trajectory {trajectory.id} from model {trajectory.model_id} "
            f"(status={trajectory.status}):\n"
            f"{items}\n"
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


def build_identity_block(identity: FusionIdentity) -> str:
    """Factual fusion-identity + disclosure carve-out injected into prompts.

    This is code-side mechanism (not a user-editable prompt) so a committed
    ``synthesizer_system`` override can never silently disable disclosure or stale
    the dynamic model list. The default behavior is unchanged - the model only
    discloses when the user directly asks what is answering them.
    """
    panel = ", ".join(identity.panel) if identity.panel else "(unknown)"
    lines = [
        "Fusion identity (factual; for disclosure only):",
        f"- Panel members (independent candidates for this request): {panel}",
    ]
    if identity.judge:
        lines.append(f"- Judge (comparison/analysis): {identity.judge}")
    if identity.synthesizer:
        lines.append(f"- Synthesizer (you, writing this answer): {identity.synthesizer}")
    if identity.self_id:
        ordinal = (
            f" (peer {identity.self_ordinal} of {len(identity.panel)})"
            if identity.self_ordinal is not None and identity.panel
            else ""
        )
        lines.append(f"- You are: {identity.self_id}{ordinal}")
    lines.append(
        "Default behavior is unchanged: do not narrate the fusion process. The single exception: "
        "if the user directly asks what model or configuration is answering them "
        '(e.g. "what model are you?"), answer truthfully using the identity above - name the panel '
        "members, the judge, and yourself as the synthesizer."
    )
    return "\n".join(lines)


def build_judge_system(judge_system: str, *, harness_system: str | None = None) -> str:
    """System prompt for the judge's gap analysis.

    When ``harness_system`` (the coding-harness system prompt) is passed through it
    becomes the primary base and the comparison instructions ride on top as a
    suffix; otherwise the judge prompt is used standalone (the prior behavior).
    """
    if harness_system:
        return f"{harness_system}\n\n{judge_system}"
    return judge_system


def build_fuse_system(
    trajectories: Sequence[Trajectory],
    *,
    synthesizer_system: str,
    harness_system: str | None = None,
    synthesizer_overridden: bool = False,
    identity: FusionIdentity | None = None,
    analysis: FusionAnalysis | None = None,
    tools_present: bool = False,
) -> str:
    """System prompt for the synthesizer producing the fused output.

    Layered base -> suffix. When ``harness_system`` (the coding tool's own system
    prompt, e.g. Codex/Claude Code) is passed through it is the *primary* block, so
    the synthesizer keeps the harness's SOTA agent prompt and conventions; the
    fusion mechanics (:data:`FUSION_SYNTHESIZER_FRAMING`) ride on top as a
    subordinate suffix, and a user ``synthesizer_system`` override is folded in
    after it (``synthesizer_overridden``) so overrides still apply. With no harness
    prompt the (possibly overridden) ``synthesizer_system`` is the base, preserving
    the prior standalone behavior.

    When tools are present the workspace-grounding fact is appended -
    :data:`AGENT_WORKSPACE_GROUNDING` when the harness prompt already supplies the
    loop semantics, else the fuller :data:`AGENT_STEP_CONTRACT`. The identity block,
    candidate trajectories, and (when available) the judge's gap analysis are
    injected as reference/disclosure.
    """
    sections: list[str] = []
    if harness_system:
        sections.append(harness_system)
        sections.append(FUSION_SYNTHESIZER_FRAMING)
        if synthesizer_overridden:
            sections.append(synthesizer_system)
    else:
        sections.append(synthesizer_system)
    if tools_present:
        sections.append(AGENT_WORKSPACE_GROUNDING if harness_system else AGENT_STEP_CONTRACT)
    if identity is not None:
        sections.append(build_identity_block(identity))
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
