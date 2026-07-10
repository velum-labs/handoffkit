from __future__ import annotations

import pytest
from hyperkit.stats import (
    aggregate_seeds,
    bootstrap_ci,
    clustered_bootstrap_ci,
    clustered_bootstrap_statistic,
    mcnemar,
    pass_at_k,
    wilson_interval,
)


def test_wilson_known_interval_and_empty() -> None:
    ci = wilson_interval(19, 30)
    assert ci.estimate == pytest.approx(19 / 30)
    assert ci.low == pytest.approx(0.4551, abs=0.001)
    assert ci.high == pytest.approx(0.7813, abs=0.001)
    empty = wilson_interval(0, 0)
    assert (empty.estimate, empty.low, empty.high) == (0.0, 0.0, 0.0)


def test_pass_at_k_and_seed_aggregate() -> None:
    assert pass_at_k(10, 3, 1) == pytest.approx(0.3)
    assert pass_at_k(10, 9, 2) == 1.0
    agg = aggregate_seeds([0.5, 0.7, 0.9])
    assert agg.runs == 3
    assert agg.mean == pytest.approx(0.7)


def test_bootstraps_are_seeded_and_clustered() -> None:
    assert bootstrap_ci([0, 1, 1], seed=42) == bootstrap_ci([0, 1, 1], seed=42)
    lo, hi = clustered_bootstrap_ci([[1, 1], [0, 0], [1, 0]], seed=42)
    assert 0.0 <= lo <= hi <= 1.0
    groups = {"a": ["x", "y"], "b": ["z"]}
    ci = clustered_bootstrap_statistic(
        groups,
        lambda sample: sum(v == "x" for v in sample) / len(sample),
        seed=7,
    )
    assert 0.0 <= ci[0] <= ci[1] <= 1.0


def test_exact_mcnemar() -> None:
    result = mcnemar(
        [True, True, False, False],
        [True, False, True, False],
    )
    assert (result.wins, result.losses) == (1, 1)
    assert result.p_value == 1.0

