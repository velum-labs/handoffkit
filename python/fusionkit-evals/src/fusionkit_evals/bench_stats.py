"""Statistical helpers for turning raw pass/fail counts into honest numbers.

pass@1 is a binomial proportion, so a point estimate alone is misleading at the
sample sizes benchmarks run at. This module provides Wilson score intervals, the
standard unbiased pass@k estimator, multi-seed aggregation, and a bootstrap CI.
"""

from __future__ import annotations

import math
import random
from collections.abc import Sequence

from pydantic import BaseModel


class ProportionCI(BaseModel):
    successes: int
    n: int
    estimate: float
    low: float
    high: float
    method: str = "wilson"


def wilson_interval(successes: int, n: int, z: float = 1.96) -> ProportionCI:
    """Wilson score interval for a binomial proportion (better than normal at small n)."""

    if n <= 0:
        return ProportionCI(successes=successes, n=n, estimate=0.0, low=0.0, high=0.0)
    phat = successes / n
    z2 = z * z
    denom = 1.0 + z2 / n
    center = (phat + z2 / (2 * n)) / denom
    margin = (z * math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n)) / denom
    return ProportionCI(
        successes=successes,
        n=n,
        estimate=phat,
        low=max(0.0, center - margin),
        high=min(1.0, center + margin),
    )


def pass_at_k(n: int, c: int, k: int) -> float:
    """Unbiased pass@k estimator (Chen et al.): n samples, c correct, draws of k."""

    if k <= 0 or n <= 0:
        return 0.0
    if n - c < k:
        return 1.0
    return 1.0 - math.prod((n - c - i) / (n - i) for i in range(k))


class SeedAggregate(BaseModel):
    runs: int
    mean: float
    std: float
    low: float
    high: float


def aggregate_seeds(scores: Sequence[float], z: float = 1.96) -> SeedAggregate:
    """Aggregate per-seed pass rates into mean +/- a normal CI on the mean."""

    values = list(scores)
    if not values:
        return SeedAggregate(runs=0, mean=0.0, std=0.0, low=0.0, high=0.0)
    n = len(values)
    mean = sum(values) / n
    if n == 1:
        return SeedAggregate(runs=1, mean=mean, std=0.0, low=mean, high=mean)
    variance = sum((value - mean) ** 2 for value in values) / (n - 1)
    std = math.sqrt(variance)
    margin = z * std / math.sqrt(n)
    return SeedAggregate(
        runs=n,
        mean=mean,
        std=std,
        low=max(0.0, mean - margin),
        high=min(1.0, mean + margin),
    )


def bootstrap_ci(
    values: Sequence[float],
    *,
    iterations: int = 2000,
    alpha: float = 0.05,
    seed: int = 0,
) -> tuple[float, float]:
    """Percentile bootstrap CI for the mean of per-task scores."""

    data = list(values)
    if not data:
        return 0.0, 0.0
    rng = random.Random(seed)
    n = len(data)
    means = []
    for _ in range(iterations):
        sample = [data[rng.randrange(n)] for _ in range(n)]
        means.append(sum(sample) / n)
    means.sort()
    low_index = max(0, int((alpha / 2) * iterations))
    high_index = min(iterations - 1, int((1 - alpha / 2) * iterations))
    return means[low_index], means[high_index]


__all__ = [
    "ProportionCI",
    "SeedAggregate",
    "aggregate_seeds",
    "bootstrap_ci",
    "pass_at_k",
    "wilson_interval",
]
