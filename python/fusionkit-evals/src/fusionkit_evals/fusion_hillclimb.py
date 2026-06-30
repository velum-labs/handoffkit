"""Self-healing hill climb: drive the fused compound to beat the best single model.

The fusion thesis is that a panel of decorrelated models, judged and synthesized,
beats the best single model. This module measures whether that holds on a frozen
:class:`~fusionkit_evals.candidate_bank.CandidateBank` and hill-climbs the
judge/synthesizer prompts (Tier 1, cheap replay over the bank) until the fused
answer beats the best single panel member with paired-McNemar significance, or a
budget/iteration cap is hit.

Tier 1 (prompt search) is the deterministic engine here; it reuses
:func:`~fusionkit_evals.prompt_tuning.optimize`. Tier 2 (config knobs) and Tier 3
(synthesis source changes) are open-ended and orchestrated by the `fusion-hillclimb`
skill, which uses :func:`diagnose_bank` to decide what to try next and re-runs this
engine to re-measure after each change.

The best single model is computed from the bank's per-candidate pass flags, so the
"does the compound beat the best individual?" question is answered on the exact same
tasks the compound is scored on (apples-to-apples).
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence

from pydantic import BaseModel, Field

from fusionkit_evals.candidate_bank import CandidateBank
from fusionkit_evals.prompt_tuning import (
    McNemarResult,
    PromptProposer,
    PromptVariant,
    TunableRole,
    TunerRuntime,
    TuningResult,
    evaluate_variant,
    mcnemar,
    optimize,
    select_decision_tasks,
    split_dev_val,
)


class BestSingle(BaseModel):
    """The strongest single panel member, with its per-task pass map."""

    model_id: str
    pass_rate: float
    pass_map: dict[str, bool] = Field(default_factory=dict)


class ClimbDiagnosis(BaseModel):
    """Whether fusion can win on this bank, and where the gap is."""

    n_tasks: int
    n_decision: int
    best_single_model: str | None = None
    best_single_rate: float | None = None
    oracle_ceiling: float | None = None
    oracle_headroom: float | None = None
    mean_failure_correlation: float | None = None
    lopsided: bool = False
    note: str = ""


class TargetCheck(BaseModel):
    """Result of comparing the fused compound to the best single model."""

    fused_rate: float
    best_single_rate: float
    uplift: float
    mcnemar: McNemarResult
    beats_best_single: bool


class ClimbResult(BaseModel):
    """Outcome of one Tier-1 climb on one role."""

    role: TunableRole
    diagnosis: ClimbDiagnosis
    tuning: TuningResult
    target: TargetCheck
    best_prompt: str | None = None


def best_single_baseline(bank: CandidateBank, task_ids: Sequence[str] | None = None) -> BestSingle:
    """The single panel member with the highest pass rate over the given tasks.

    ``task_ids`` restricts the comparison set (e.g. the val split); when omitted all
    bank tasks are used. The pass map is the per-task pass/fail for that model, ready
    to pair against the fused answer in a McNemar test.
    """
    selected = set(task_ids) if task_ids is not None else None
    per_model: dict[str, dict[str, bool]] = {}
    for task in bank.tasks:
        if selected is not None and task.task_id not in selected:
            continue
        for candidate in task.candidates:
            per_model.setdefault(candidate.model_id, {})[task.task_id] = candidate.passed
    if not per_model:
        return BestSingle(model_id="", pass_rate=0.0)
    rates = {
        model_id: (sum(1 for v in passes.values() if v) / len(passes) if passes else 0.0)
        for model_id, passes in per_model.items()
    }
    best_model = max(rates, key=lambda model_id: rates[model_id])
    return BestSingle(
        model_id=best_model,
        pass_rate=rates[best_model],
        pass_map=per_model[best_model],
    )


def diagnose_bank(bank: CandidateBank) -> ClimbDiagnosis:
    """Diagnose fusion headroom on a bank: oracle ceiling, best single, decorrelation."""
    tasks = bank.tasks
    if not tasks:
        return ClimbDiagnosis(n_tasks=0, n_decision=0, note="empty bank")
    decision = [task for task in tasks if task.is_decision_task]
    best = best_single_baseline(bank)
    # Measured oracle: a task is winnable iff at least one candidate passed it.
    oracle_ceiling = sum(1 for task in tasks if task.oracle_pass) / len(tasks)
    oracle_headroom = oracle_ceiling - best.pass_rate
    corr = _mean_failure_correlation(bank)
    lopsided = oracle_headroom < 0.02
    note = (
        "low headroom: candidates fail together (correlated) or one model dominates; "
        "fusion has little to gain -- consider a more decorrelated panel"
        if lopsided
        else "headroom exists: candidates fail on different tasks, so a better judge/"
        "synthesizer can convert oracle headroom into real fused wins"
    )
    return ClimbDiagnosis(
        n_tasks=len(tasks),
        n_decision=len(decision),
        best_single_model=best.model_id or None,
        best_single_rate=best.pass_rate,
        oracle_ceiling=oracle_ceiling,
        oracle_headroom=oracle_headroom,
        mean_failure_correlation=corr,
        lopsided=lopsided,
        note=note,
    )


def check_target(
    best_single: BestSingle,
    fused_passes: Mapping[str, bool],
) -> TargetCheck:
    """Compare the fused pass map to the best single model (paired McNemar)."""
    paired_incumbent = {
        task_id: best_single.pass_map[task_id]
        for task_id in fused_passes
        if task_id in best_single.pass_map
    }
    paired_candidate = {task_id: fused_passes[task_id] for task_id in paired_incumbent}
    comparison = mcnemar(paired_incumbent, paired_candidate)
    fused_rate = (
        sum(1 for v in paired_candidate.values() if v) / len(paired_candidate)
        if paired_candidate
        else 0.0
    )
    best_rate = (
        sum(1 for v in paired_incumbent.values() if v) / len(paired_incumbent)
        if paired_incumbent
        else 0.0
    )
    uplift = fused_rate - best_rate
    return TargetCheck(
        fused_rate=fused_rate,
        best_single_rate=best_rate,
        uplift=uplift,
        mcnemar=comparison,
        beats_best_single=uplift > 0 and comparison.significant,
    )


async def run_climb(
    runtime: TunerRuntime,
    bank: CandidateBank,
    *,
    proposer: PromptProposer,
    role: TunableRole = "synthesizer_system",
    base_variant: PromptVariant | None = None,
    val_fraction: float = 0.4,
    seed: int = 0,
    max_iterations: int = 8,
    patience: int = 3,
) -> ClimbResult:
    """Run one Tier-1 climb on ``role`` and measure fused vs best-single on val.

    Splits the judge-decidable tasks into dev/val, hill-climbs the prompt with
    :func:`optimize` (McNemar-gated against the incumbent prompt), then evaluates the
    best variant's fused answers on the held-out val split and compares them to the
    best single model on the same val tasks.
    """
    diagnosis = diagnose_bank(bank)
    decision = select_decision_tasks(bank)
    split = split_dev_val(decision, val_fraction=val_fraction, seed=seed)
    by_id = {task.task_id: task for task in bank.tasks}
    dev_tasks = [by_id[task_id] for task_id in split.dev]
    val_tasks = [by_id[task_id] for task_id in split.val]

    tuning = await optimize(
        runtime,
        dev_tasks=dev_tasks,
        val_tasks=val_tasks,
        proposer=proposer,
        base_variant=base_variant,
        role=role,
        max_iterations=max_iterations,
        patience=patience,
    )

    # Fused answers of the best variant on the held-out val split, vs best single.
    fused_val = await evaluate_variant(runtime, tuning.best_variant, val_tasks)
    best_single = best_single_baseline(bank, task_ids=split.val)
    target = check_target(best_single, fused_val.passes)

    return ClimbResult(
        role=role,
        diagnosis=diagnosis,
        tuning=tuning,
        target=target,
        best_prompt=tuning.best_variant.role_text(role),
    )


def _mean_failure_correlation(bank: CandidateBank) -> float | None:
    """Mean pairwise Pearson correlation of candidate failures across the panel.

    Lower means members fail on different tasks (more decorrelation, more fusion
    headroom). Computed over tasks where every panel member has a candidate.
    """
    failures: dict[str, list[float]] = {}
    for task in bank.tasks:
        for candidate in task.candidates:
            failures.setdefault(candidate.model_id, []).append(0.0 if candidate.passed else 1.0)
    model_ids = sorted(failures)
    correlations: list[float] = []
    for left_index, left_id in enumerate(model_ids):
        for right_id in model_ids[left_index + 1 :]:
            left = failures[left_id]
            right = failures[right_id]
            paired = min(len(left), len(right))
            value = _pearson(left[:paired], right[:paired])
            if value is not None:
                correlations.append(value)
    if not correlations:
        return None
    return sum(correlations) / len(correlations)


def _pearson(left: list[float], right: list[float]) -> float | None:
    if len(left) < 2:
        return None
    left_mean = sum(left) / len(left)
    right_mean = sum(right) / len(right)
    numerator = sum((a - left_mean) * (b - right_mean) for a, b in zip(left, right, strict=True))
    left_denom = math.sqrt(sum((a - left_mean) ** 2 for a in left))
    right_denom = math.sqrt(sum((b - right_mean) ** 2 for b in right))
    if left_denom == 0 or right_denom == 0:
        return None
    return numerator / (left_denom * right_denom)


__all__ = [
    "BestSingle",
    "ClimbDiagnosis",
    "ClimbResult",
    "TargetCheck",
    "best_single_baseline",
    "check_target",
    "diagnose_bank",
    "run_climb",
]
