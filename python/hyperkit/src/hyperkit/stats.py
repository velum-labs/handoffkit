"""The sole statistics module for the platform.

Turns raw pass/fail counts into honest numbers: Wilson score intervals, the
unbiased pass@k estimator, multi-seed aggregation, a percentile bootstrap, a
cluster-aware bootstrap, and McNemar's paired test. This is the single home for
these functions across hyperkit and its consumers -- the previously duplicated
copies (analysis analyzers, fusionkit-evals.bench_stats, phase0/oss scripts) all
resolve here.
"""

from __future__ import annotations

import math
import random
from collections.abc import Callable, Mapping, Sequence
from typing import TypeVar

from pydantic import BaseModel

T = TypeVar("T")


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


def clustered_bootstrap_ci(
    clusters: Sequence[Sequence[float]],
    *,
    iterations: int = 2000,
    alpha: float = 0.05,
    seed: int = 0,
) -> tuple[float, float]:
    """Cluster-aware percentile bootstrap: resample whole clusters, not rows.

    Consolidates the clustered-CI logic that was independently reimplemented in
    analyze_c1_c2, oss_scan, and c3_transfer_pilot. Each cluster is a list of
    per-item scores; resampling is over clusters (with replacement), and the
    statistic is the pooled mean of the resampled clusters' items.
    """

    groups = [list(c) for c in clusters if len(c) > 0]
    if not groups:
        return 0.0, 0.0
    rng = random.Random(seed)
    k = len(groups)
    means: list[float] = []
    for _ in range(iterations):
        picked = [groups[rng.randrange(k)] for _ in range(k)]
        pooled = [v for g in picked for v in g]
        if pooled:
            means.append(sum(pooled) / len(pooled))
    if not means:
        return 0.0, 0.0
    means.sort()
    low_index = max(0, int((alpha / 2) * len(means)))
    high_index = min(len(means) - 1, int((1 - alpha / 2) * len(means)))
    return means[low_index], means[high_index]


def clustered_bootstrap_statistic(
    clusters: Mapping[str, Sequence[T]],
    statistic: Callable[[Sequence[T]], float],
    *,
    iterations: int = 2000,
    alpha: float = 0.05,
    seed: int = 0,
) -> tuple[float, float]:
    """Cluster-resampled CI for an arbitrary statistic.

    This is the shared primitive for panel headroom/oracle CIs in phase0 and
    OSS scans: sample whole clusters with replacement, flatten their rows, and
    evaluate the caller's domain-specific statistic.
    """

    groups = [list(clusters[key]) for key in sorted(clusters) if clusters[key]]
    if not groups:
        return float("nan"), float("nan")
    rng = random.Random(seed)
    k = len(groups)
    values: list[float] = []
    for _ in range(iterations):
        pooled = [value for _ in range(k) for value in groups[rng.randrange(k)]]
        values.append(statistic(pooled))
    values.sort()
    low_index = max(0, int((alpha / 2) * len(values)))
    high_index = min(len(values) - 1, int((1 - alpha / 2) * len(values)))
    return values[low_index], values[high_index]


class McNemarResult(BaseModel):
    wins: int  # candidate/b-only successes
    losses: int  # incumbent/a-only successes
    statistic: float | None
    p_value: float
    significant: bool


def mcnemar(a_correct: Sequence[bool], b_correct: Sequence[bool]) -> McNemarResult:
    """McNemar's paired test on two aligned boolean outcome vectors.

    Uses the exact binomial p-value on the discordant pairs (robust at the small
    discordant counts benchmark comparisons produce). Consolidates the copy in
    fusionkit-evals.prompt_tuning so paired comparisons are available platform-wide.
    """

    if len(a_correct) != len(b_correct):
        raise ValueError("a_correct and b_correct must be the same length")
    b = sum(1 for a, bb in zip(a_correct, b_correct, strict=True) if a and not bb)
    c = sum(1 for a, bb in zip(a_correct, b_correct, strict=True) if bb and not a)
    n = b + c
    if n == 0:
        return McNemarResult(
            wins=0,
            losses=0,
            statistic=None,
            p_value=1.0,
            significant=False,
        )
    # Continuity-corrected chi-square statistic (reported for context).
    statistic = (abs(b - c) - 1) ** 2 / n if n > 0 else 0.0
    # Exact two-sided binomial p-value under p=0.5 on the discordant pairs.
    k = min(b, c)
    tail = sum(math.comb(n, i) for i in range(0, k + 1)) / (2**n)
    p_value = min(1.0, 2.0 * tail)
    return McNemarResult(
        wins=c,
        losses=b,
        statistic=statistic,
        p_value=p_value,
        significant=p_value < 0.05 and c > b,
    )


__all__ = [
    "McNemarResult",
    "ProportionCI",
    "SeedAggregate",
    "aggregate_seeds",
    "bootstrap_ci",
    "clustered_bootstrap_ci",
    "clustered_bootstrap_statistic",
    "mcnemar",
    "pass_at_k",
    "wilson_interval",
]
