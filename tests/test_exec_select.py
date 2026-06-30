from __future__ import annotations

from fusionkit_evals.exec_select import CandidateSample, select_index, selected_private_pass


def _s(model: str, pub_passed: int, pub_total: int, private: bool) -> CandidateSample:
    return CandidateSample(
        model_id=model, public_passed=pub_passed, public_total=pub_total, private_pass=private
    )


def test_selects_candidate_passing_all_public_over_partial() -> None:
    samples = [
        _s("gpt", 1, 3, private=False),  # partial public
        _s("opus", 3, 3, private=True),  # passes all public -> selected
    ]
    assert select_index(samples) == 1
    assert selected_private_pass(samples) is True


def test_prefers_more_public_passes_on_ties_first() -> None:
    samples = [
        _s("gpt", 2, 4, private=False),
        _s("opus", 2, 4, private=True),  # same key as gpt -> earliest wins (gpt)
        _s("sonnet", 4, 4, private=True),  # best -> selected
    ]
    assert select_index(samples) == 2


def test_execution_selection_beats_best_single_on_decorrelated_failure() -> None:
    # The strong model fails this task (public+private); a weaker model nails it.
    # Public-test selection picks the passing one -> fused passes where best-single failed.
    samples = [
        _s("opus", 0, 3, private=False),  # best-single overall, but fails here
        _s("gpt", 3, 3, private=True),  # passes public -> selected -> private pass
    ]
    assert selected_private_pass(samples) is True


def test_falls_back_to_first_when_no_public_tests() -> None:
    samples = [_s("gpt", 0, 0, private=True), _s("opus", 0, 0, private=False)]
    assert select_index(samples) == 0
