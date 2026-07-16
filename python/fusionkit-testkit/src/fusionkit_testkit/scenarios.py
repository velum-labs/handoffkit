"""High-level scenario scripting.

These helpers encode FusionKit's fusion call graph (panel fanout, then judge
analysis, then synthesizer answer — with judge and synthesizer often being the
same endpoint, consumed FIFO) so a test scripts a whole fused turn in one
call instead of re-deriving the call order every time.
"""

from __future__ import annotations

import json
from collections.abc import Mapping

from fusionkit_testkit.behaviors import Behavior
from fusionkit_testkit.server import RouteKitSimulator

ScriptedReply = str | Behavior


def as_behavior(value: ScriptedReply) -> Behavior:
    return value if isinstance(value, Behavior) else Behavior(reply=value)


def judge_analysis(
    *,
    consensus: list[str] | None = None,
    contradictions: list[str] | None = None,
    unique_insights: list[str] | None = None,
    coverage_gaps: list[str] | None = None,
    likely_errors: list[str] | None = None,
    recommended_final_structure: list[str] | None = None,
    best_trajectory: str | None = None,
) -> str:
    """A well-formed judge analysis JSON reply (the judge model's first turn)."""
    payload: dict[str, object] = {
        "consensus": consensus or ["candidates agree"],
        "contradictions": contradictions or [],
        "unique_insights": unique_insights or [],
        "coverage_gaps": coverage_gaps or [],
        "likely_errors": likely_errors or [],
        "recommended_final_structure": recommended_final_structure or [],
    }
    if best_trajectory is not None:
        payload["best_trajectory"] = best_trajectory
    return json.dumps(payload)


def script_fused_turn(
    sim: RouteKitSimulator,
    *,
    candidates: Mapping[str, ScriptedReply],
    judge_model: str,
    answer: ScriptedReply,
    analysis: str | None = None,
    synthesizer_model: str | None = None,
) -> None:
    """Script one full fused turn: panel candidates, judge analysis, synthesis.

    ``candidates`` maps namespaced RouteKit model ids (what the simulator
    journals) to their panel replies. When ``synthesizer_model`` is unset the
    judge model serves both fuse-step roles, consumed in order: analysis first,
    answer second.
    """
    for model, reply in candidates.items():
        sim.queue(model, as_behavior(reply))
    analysis_behavior = Behavior(reply=analysis if analysis is not None else judge_analysis())
    if synthesizer_model is None or synthesizer_model == judge_model:
        sim.queue(judge_model, analysis_behavior, as_behavior(answer))
    else:
        sim.queue(judge_model, analysis_behavior)
        sim.queue(synthesizer_model, as_behavior(answer))
