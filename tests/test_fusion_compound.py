from __future__ import annotations

from fusionkit_evals.fusion_compound import (
    compare_compound_vs_individual,
    format_compound_comparison_markdown,
)
from fusionkit_evals.public_bench import ExternalBenchmarkRun, ExternalBenchmarkTaskRow


def _row(
    task_id: str,
    fused: bool,
    gpt: float,
    opus: float,
    outcome: str = "scored",
) -> ExternalBenchmarkTaskRow:
    return ExternalBenchmarkTaskRow(
        task_id=task_id,
        outcome=outcome,
        passed=fused if outcome == "scored" else None,
        score=(1.0 if fused else 0.0) if outcome == "scored" else None,
        candidate_scores={"gpt": gpt, "opus": opus},
    )


def _run(rows: list[ExternalBenchmarkTaskRow]) -> ExternalBenchmarkRun:
    return ExternalBenchmarkRun(
        suite="livecodebench",
        mount_mode="fusion_behind_agent",
        availability="ran",
        panel_id="gpt-opus",
        gateway_model="fusionkit/panel",
        resolved_tasks=sum(1 for r in rows if r.outcome == "scored"),
        total_tasks=len(rows),
        passed_tasks=sum(1 for r in rows if r.outcome == "scored" and r.passed),
        tasks=rows,
    )


def test_compound_beats_best_single_when_fusion_fixes_decorrelated_failures() -> None:
    # Best single (opus) passes 6/12; gpt covers a different subset; fused passes all.
    # Fused fixes 6 of opus's failures with 0 regressions -> McNemar-significant win.
    opus_pass = {f"t{i}" for i in range(1, 7)}  # t1..t6
    gpt_pass = {f"t{i}" for i in range(7, 11)}  # t7..t10
    rows = [
        _row(
            f"t{i}",
            fused=True,
            gpt=1.0 if f"t{i}" in gpt_pass else 0.0,
            opus=1.0 if f"t{i}" in opus_pass else 0.0,
        )
        for i in range(1, 13)
    ]
    comparison = compare_compound_vs_individual(_run(rows))
    assert comparison.n_scored == 12
    assert comparison.fused is not None and comparison.fused.pass_at_1 == 1.0
    assert comparison.best_single_model == "opus"
    assert comparison.best_single_score == 0.5
    assert comparison.uplift_vs_best_single is not None and comparison.uplift_vs_best_single > 0
    assert comparison.mcnemar_vs_best_single is not None
    assert comparison.mcnemar_vs_best_single.wins == 6
    assert comparison.mcnemar_vs_best_single.losses == 0
    assert comparison.mcnemar_vs_best_single.significant is True
    assert comparison.beats_best_single is True
    # Oracle = every task had a passing candidate or fused -> 1.0; regret 0.
    assert comparison.measured_oracle == 1.0
    assert comparison.measured_regret == 0.0


def test_excluded_and_failed_tasks_do_not_distort_rates() -> None:
    rows = [
        _row("t1", fused=True, gpt=1.0, opus=0.0),
        _row("t2", fused=False, gpt=0.0, opus=0.0),
        _row("skip", fused=False, gpt=0.0, opus=0.0, outcome="excluded"),
    ]
    comparison = compare_compound_vs_individual(_run(rows))
    assert comparison.n_scored == 2  # excluded dropped
    fused = comparison.fused
    assert fused is not None and fused.n == 2 and fused.successes == 1


def test_no_uplift_when_fused_matches_best_single() -> None:
    # Correlated: both models pass/fail together; fused tracks them -> no win.
    rows = [
        _row("t1", fused=True, gpt=1.0, opus=1.0),
        _row("t2", fused=False, gpt=0.0, opus=0.0),
        _row("t3", fused=True, gpt=1.0, opus=1.0),
        _row("t4", fused=False, gpt=0.0, opus=0.0),
    ]
    comparison = compare_compound_vs_individual(_run(rows))
    assert comparison.uplift_vs_best_single == 0.0
    assert comparison.beats_best_single is False
    assert comparison.mcnemar_vs_best_single is not None
    assert comparison.mcnemar_vs_best_single.wins == 0


def test_markdown_renders_member_and_fused_rows() -> None:
    rows = [_row("t1", fused=True, gpt=1.0, opus=0.0), _row("t2", fused=False, gpt=0.0, opus=1.0)]
    md = format_compound_comparison_markdown(compare_compound_vs_individual(_run(rows)))
    assert "Compound vs Individual" in md
    assert "fused (compound)" in md
    assert "gpt" in md and "opus" in md
    assert "Compound beats best single" in md
