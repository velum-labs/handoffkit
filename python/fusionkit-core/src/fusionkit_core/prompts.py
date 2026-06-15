from __future__ import annotations

import json
from collections.abc import Sequence

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
