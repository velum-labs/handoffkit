from __future__ import annotations

from fusionkit_evals.candidate_bank import BankCandidate, BankTask, CandidateBank
from fusionkit_evals.fusion_hillclimb import (
    BestSingle,
    best_single_baseline,
    check_target,
    diagnose_bank,
    regret_split,
)
from fusionkit_evals.prompt_tuning import PerTaskResult, PromptEval


def _task(task_id: str, gpt: bool, opus: bool) -> BankTask:
    return BankTask(
        task_id=task_id,
        prompt=f"solve {task_id}",
        tests=[{"input": "", "output": ""}],
        candidates=[
            BankCandidate(model_id="gpt", content="", passed=gpt),
            BankCandidate(model_id="opus", content="", passed=opus),
        ],
    )


def _bank(tasks: list[BankTask]) -> CandidateBank:
    return CandidateBank(signature="sig", panel_models=["gpt", "opus"], tasks=tasks)


def test_best_single_baseline_picks_higher_rate_and_builds_pass_map() -> None:
    bank = _bank(
        [
            _task("t1", gpt=True, opus=False),
            _task("t2", gpt=True, opus=True),
            _task("t3", gpt=False, opus=False),
            _task("t4", gpt=True, opus=False),
        ]
    )
    best = best_single_baseline(bank)
    assert best.model_id == "gpt"  # 3/4 vs 1/4
    assert best.pass_rate == 0.75
    assert best.pass_map == {"t1": True, "t2": True, "t3": False, "t4": True}


def test_best_single_baseline_restricts_to_task_ids() -> None:
    bank = _bank([_task("t1", gpt=True, opus=False), _task("t2", gpt=False, opus=True)])
    best = best_single_baseline(bank, task_ids=["t2"])
    assert best.model_id == "opus"
    assert best.pass_map == {"t2": True}


def test_diagnose_bank_reports_headroom_for_decorrelated_panel() -> None:
    # gpt and opus fail on disjoint tasks -> oracle covers all, headroom > 0.
    bank = _bank(
        [
            _task("t1", gpt=True, opus=False),
            _task("t2", gpt=False, opus=True),
            _task("t3", gpt=True, opus=False),
            _task("t4", gpt=False, opus=True),
        ]
    )
    diag = diagnose_bank(bank)
    assert diag.n_tasks == 4
    assert diag.n_decision == 4  # every task is judge-decidable
    assert diag.best_single_rate == 0.5
    assert diag.oracle_ceiling == 1.0
    assert diag.oracle_headroom == 0.5
    assert diag.lopsided is False
    # Perfectly anti-correlated failures -> negative correlation.
    assert diag.mean_failure_correlation is not None and diag.mean_failure_correlation < 0


def test_diagnose_bank_flags_lopsided_low_headroom() -> None:
    # Candidates pass/fail together -> oracle == best single, no headroom.
    bank = _bank(
        [
            _task("t1", gpt=True, opus=True),
            _task("t2", gpt=False, opus=False),
            _task("t3", gpt=True, opus=True),
        ]
    )
    diag = diagnose_bank(bank)
    assert diag.oracle_headroom == 0.0
    assert diag.lopsided is True


def test_check_target_significant_when_fused_fixes_six_failures() -> None:
    best = best_single_baseline(
        _bank([_task(f"t{i}", gpt=False, opus=False) for i in range(1, 7)])
    )
    # best single fails all 6; fused passes all 6 -> wins=6, losses=0 -> significant.
    fused = {f"t{i}": True for i in range(1, 7)}
    target = check_target(best, fused)
    assert target.uplift == 1.0
    assert target.mcnemar.wins == 6 and target.mcnemar.losses == 0
    assert target.mcnemar.significant is True
    assert target.beats_best_single is True


def test_check_target_not_significant_for_small_or_tied_gains() -> None:
    best = BestSingle(model_id="gpt", pass_rate=0.5, pass_map={"t1": False, "t2": True})
    target = check_target(best, {"t1": True, "t2": True})
    assert target.uplift == 0.5
    assert target.beats_best_single is False  # only 1 discordant win, not significant


def _eval(results: dict[str, PerTaskResult]) -> PromptEval:
    successes = sum(1 for r in results.values() if r.passed)
    return PromptEval(
        prompt_hash="h",
        n=len(results),
        successes=successes,
        score=successes / len(results) if results else 0.0,
        ci_low=0.0,
        ci_high=1.0,
        passes={tid: r.passed for tid, r in results.items()},
        task_results=results,
    )


def test_regret_split_is_additive_and_attributes_components() -> None:
    tasks = [
        # t1: judge picked the passing candidate but the rewrite failed -> synthesis regret.
        _task("t1", gpt=True, opus=False),
        # t2: judge picked the failing candidate and fused failed -> judge regret.
        _task("t2", gpt=False, opus=True),
        # t3: everything passed -> no regret.
        _task("t3", gpt=True, opus=True),
        # t4: oracle-impossible task, fused failed -> no regret to attribute.
        _task("t4", gpt=False, opus=False),
    ]
    results = {
        "t1": PerTaskResult(passed=False, judge_pick_model="gpt", judge_pick_passed=True),
        "t2": PerTaskResult(passed=False, judge_pick_model="gpt", judge_pick_passed=False),
        "t3": PerTaskResult(passed=True, judge_pick_model="gpt", judge_pick_passed=True),
        "t4": PerTaskResult(passed=False, judge_pick_model="gpt", judge_pick_passed=False),
    }
    split = regret_split(tasks, _eval(results))
    assert split.n == 4
    assert split.oracle_rate == 0.75  # t1, t2, t3
    assert split.judge_pick_rate == 0.5  # picks pass on t1, t3
    assert split.fused_rate == 0.25  # only t3
    assert split.total_regret == 0.5
    assert split.judge_regret == 0.25  # oracle - pick
    assert split.synthesis_regret == 0.25  # pick - fused
    assert abs(split.total_regret - (split.judge_regret + split.synthesis_regret)) < 1e-9
    # Decision tasks with a named pick: t1 (correct), t2 (wrong) -> 50%; both strict.
    assert split.judge_pick_accuracy == 0.5
    assert split.judge_pick_accuracy_strict == 0.5


def test_regret_split_falls_back_to_fused_when_no_pick_named() -> None:
    tasks = [_task("t1", gpt=True, opus=False)]
    results = {"t1": PerTaskResult(passed=True)}  # no judge pick recorded
    split = regret_split(tasks, _eval(results))
    assert split.picks_named == 0
    assert split.judge_pick_rate == split.fused_rate == 1.0
    assert split.judge_regret == 0.0
    assert split.judge_pick_accuracy is None


def test_regret_split_empty_results() -> None:
    split = regret_split([], _eval({}))
    assert split.n == 0
    assert split.total_regret == 0.0
