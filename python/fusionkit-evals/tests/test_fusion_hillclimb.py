from __future__ import annotations

from fusionkit_evals.candidate_bank import BankCandidate, BankTask, CandidateBank
from fusionkit_evals.fusion_hillclimb import (
    BestSingle,
    best_single_baseline,
    check_target,
    diagnose_bank,
)


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
