from __future__ import annotations

from fusionkit_evals.pareto import ParetoPoint, find_pareto_front
from fusionkit_evals.scorers import contains_expected, exact_match


def test_scorers() -> None:
    assert exact_match("Answer", "answer") == 1.0
    assert contains_expected("The answer is Paris.", "paris") == 1.0
    assert contains_expected("The answer is Rome.", "paris") == 0.0


def test_pareto_front_filters_dominated_points() -> None:
    points = [
        ParetoPoint(id="slow-good", quality=0.9, latency_s=10.0, peak_memory_gb=8.0),
        ParetoPoint(id="fast-good", quality=0.9, latency_s=5.0, peak_memory_gb=8.0),
        ParetoPoint(id="fast-bad", quality=0.5, latency_s=5.0, peak_memory_gb=8.0),
    ]

    front = find_pareto_front(points)

    assert [point.id for point in front] == ["fast-good"]
