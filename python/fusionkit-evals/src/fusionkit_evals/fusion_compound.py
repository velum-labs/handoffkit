"""Apples-to-apples compound-vs-individual comparison from one benchmark run.

A public-benchmark run scores each panel member's own solution and the fused
output on the *same* problems with the *same* verifier (see the LiveCodeBench
adapter's per-candidate scoring). This module turns that per-task data into the
headline comparison the public-bench report does not emit directly: each model's
measured pass@1 with a Wilson interval, the fused pass@1, the uplift over the
best single model, and a paired McNemar test of fused vs that best single model.

Unlike the published leaderboard table (different harness/version/subset, "context
only"), every number here is measured within the one run, so it is a like-for-like
individual-vs-compound comparison.
"""

from __future__ import annotations

from collections.abc import Mapping

from pydantic import BaseModel, Field

from fusionkit_evals.bench_stats import wilson_interval
from fusionkit_evals.prompt_tuning import McNemarResult, mcnemar
from fusionkit_evals.public_bench import ExternalBenchmarkRun, ExternalBenchmarkTaskRow

# Public coding suites here score all-or-nothing pass@1, so a candidate/fused
# score is a pass iff it reaches the full mark.
_PASS_THRESHOLD = 1.0


class ModelRate(BaseModel):
    """One model's measured pass@1 over the scored tasks, with a Wilson CI."""

    model_id: str
    n: int
    successes: int
    pass_at_1: float
    ci_low: float
    ci_high: float


class CompoundComparison(BaseModel):
    """Measured individual-vs-compound comparison for one run."""

    suite: str
    panel_id: str
    n_scored: int
    members: list[ModelRate] = Field(default_factory=list)
    fused: ModelRate | None = None
    best_single_model: str | None = None
    best_single_score: float | None = None
    uplift_vs_best_single: float | None = None
    measured_oracle: float | None = None
    measured_regret: float | None = None
    mcnemar_vs_best_single: McNemarResult | None = None
    beats_best_single: bool = False


def _is_pass(score: float | None) -> bool:
    return score is not None and score >= _PASS_THRESHOLD


def _fused_pass(row: ExternalBenchmarkTaskRow) -> bool | None:
    if row.passed is not None:
        return row.passed
    if row.score is not None:
        return row.score >= _PASS_THRESHOLD
    return None


def _rate(model_id: str, passes: Mapping[str, bool]) -> ModelRate:
    n = len(passes)
    successes = sum(1 for value in passes.values() if value)
    ci = wilson_interval(successes, n)
    return ModelRate(
        model_id=model_id,
        n=n,
        successes=successes,
        pass_at_1=ci.estimate,
        ci_low=ci.low,
        ci_high=ci.high,
    )


def compare_compound_vs_individual(run: ExternalBenchmarkRun) -> CompoundComparison:
    """Build the measured individual-vs-compound comparison from a run.

    Only ``scored`` tasks count (model_failed/infra_error/excluded are kept out of
    the rate so failures never distort it). The fused-vs-best-single McNemar test is
    paired over the tasks where both have a result.
    """
    scored = [row for row in run.tasks if row.outcome == "scored"]

    # Per-member pass map (task_id -> passed) over tasks where the member ran.
    member_passes: dict[str, dict[str, bool]] = {}
    fused_passes: dict[str, bool] = {}
    for row in scored:
        fused = _fused_pass(row)
        if fused is not None:
            fused_passes[row.task_id] = fused
        for model_id, score in row.candidate_scores.items():
            member_passes.setdefault(model_id, {})[row.task_id] = _is_pass(score)

    members = [_rate(model_id, member_passes[model_id]) for model_id in sorted(member_passes)]
    fused_rate = _rate("fused", fused_passes) if fused_passes else None

    best_single = max(members, key=lambda rate: rate.pass_at_1, default=None)
    uplift: float | None = None
    comparison: McNemarResult | None = None
    beats = False
    if best_single is not None and fused_rate is not None:
        uplift = fused_rate.pass_at_1 - best_single.pass_at_1
        best_passes = member_passes[best_single.model_id]
        # Pair on tasks both ran; incumbent = best single model, candidate = fused.
        paired_incumbent = {tid: best_passes[tid] for tid in fused_passes if tid in best_passes}
        paired_candidate = {tid: fused_passes[tid] for tid in paired_incumbent}
        comparison = mcnemar(paired_incumbent, paired_candidate)
        beats = uplift > 0 and comparison.significant

    measured_oracle, measured_regret = _oracle_regret(scored, fused_passes)

    return CompoundComparison(
        suite=run.suite,
        panel_id=run.panel_id,
        n_scored=len(scored),
        members=members,
        fused=fused_rate,
        best_single_model=best_single.model_id if best_single else None,
        best_single_score=best_single.pass_at_1 if best_single else None,
        uplift_vs_best_single=uplift,
        measured_oracle=measured_oracle,
        measured_regret=measured_regret,
        mcnemar_vs_best_single=comparison,
        beats_best_single=beats,
    )


def _oracle_regret(
    scored: list[ExternalBenchmarkTaskRow],
    fused_passes: Mapping[str, bool],
) -> tuple[float | None, float | None]:
    """Measured oracle (best of fused + any candidate) and judge regret (oracle - fused)."""
    oracle_hits: list[float] = []
    fused_hits: list[float] = []
    for row in scored:
        fused = fused_passes.get(row.task_id)
        if fused is None:
            continue
        candidate_pass = any(_is_pass(score) for score in row.candidate_scores.values())
        oracle_hits.append(1.0 if (fused or candidate_pass) else 0.0)
        fused_hits.append(1.0 if fused else 0.0)
    if not fused_hits:
        return None, None
    oracle = sum(oracle_hits) / len(oracle_hits)
    fused_rate = sum(fused_hits) / len(fused_hits)
    return oracle, oracle - fused_rate


def format_compound_comparison_markdown(comparison: CompoundComparison) -> str:
    """Render the apples-to-apples table: each model vs the fused compound."""
    lines = [
        f"# Compound vs Individual (measured, same run): {comparison.suite}",
        "",
        f"- Panel: {comparison.panel_id}",
        f"- Scored tasks: {comparison.n_scored}",
        "",
        "| Model | pass@1 | 95% CI (Wilson) | n |",
        "| --- | ---: | :--: | ---: |",
    ]
    for member in comparison.members:
        lines.append(
            f"| {member.model_id} | {member.pass_at_1:.4f} | "
            f"[{member.ci_low:.4f}, {member.ci_high:.4f}] | {member.n} |"
        )
    if comparison.fused is not None:
        fused = comparison.fused
        lines.append(
            f"| **fused (compound)** | **{fused.pass_at_1:.4f}** | "
            f"[{fused.ci_low:.4f}, {fused.ci_high:.4f}] | {fused.n} |"
        )
    lines.extend(
        [
            "",
            f"- Best single model: {comparison.best_single_model or '-'} "
            f"({_fmt(comparison.best_single_score)})",
            f"- Fusion uplift vs best single: {_fmt(comparison.uplift_vs_best_single)}",
            f"- Measured oracle ceiling: {_fmt(comparison.measured_oracle)}",
            f"- Judge regret (oracle - fused): {_fmt(comparison.measured_regret)}",
        ]
    )
    if comparison.mcnemar_vs_best_single is not None:
        mc = comparison.mcnemar_vs_best_single
        lines.append(
            f"- McNemar fused vs best single: wins={mc.wins} losses={mc.losses} "
            f"statistic={_fmt(mc.statistic)} significant={'yes' if mc.significant else 'no'}"
        )
    lines.append(
        f"- Compound beats best single (uplift>0 and significant): "
        f"{'YES' if comparison.beats_best_single else 'no'}"
    )
    lines.append("")
    return "\n".join(lines)


def _fmt(value: float | None) -> str:
    return "-" if value is None else f"{value:.4f}"


__all__ = [
    "CompoundComparison",
    "ModelRate",
    "compare_compound_vs_individual",
    "format_compound_comparison_markdown",
]
