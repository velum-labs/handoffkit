"""Deferral-curve evaluation (S 7 and Appendix E.2 of arXiv:2502.08773v2).

A deferral curve traces the quality/cost trade-off of a router as the
Lagrange multiplier lambda sweeps [0, +inf): each lambda yields per-prompt
routing decisions, hence one (average cost, average quality) point.

Metrics reported in the paper and implemented here:

- ``area_under_curve``: area under the Pareto-cleaned curve on a cost axis
  normalised by the most expensive LLM, integrated from 0 to a target
  fraction (1.0 for "Area", 0.5 for "Area (50%)"). Below the cheapest
  achievable cost the curve is extended flat at its first point's quality,
  and above its last point flat at the final quality; both extensions apply
  identically to every method, so comparisons are fair.
- ``quality_neutral_cost``: the minimum cost at which the router matches the
  most accurate LLM's quality, relative to that LLM's cost (QNC).
- ``select_n_clusters``: the Appendix F.1 hyper-parameter procedure --
  represent the *training* LLMs with training-set labels, route them on the
  validation set, and keep the K with the largest deferral-curve area.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass

import numpy as np

from .routers import UniRouteKMeans, ZeroRouter, route


@dataclass(frozen=True)
class DeferralCurve:
    """Pareto-cleaned (cost, quality) points, sorted by increasing cost."""

    costs: np.ndarray
    qualities: np.ndarray

    def __post_init__(self) -> None:
        if self.costs.shape != self.qualities.shape or self.costs.ndim != 1:
            raise ValueError("costs and qualities must be 1-D arrays of equal length")
        if self.costs.shape[0] == 0:
            raise ValueError("a deferral curve needs at least one point")

    def quality_at(self, cost: float) -> float:
        """Piecewise-linear quality at a cost, with flat extension at the ends."""
        return float(np.interp(cost, self.costs, self.qualities))


def default_lambda_grid(costs: np.ndarray, n_points: int = 64) -> np.ndarray:
    """A lambda sweep wide enough to cover both ends of the trade-off.

    gamma differences live in [-1, 1], so once lambda exceeds
    1 / (smallest positive cost gap) the cheapest LLM always wins; below
    ~1e-6 of that scale the cost term never overturns a gamma comparison.
    """
    costs = np.asarray(costs, dtype=np.float64)
    gaps = np.diff(np.unique(costs))
    if gaps.size == 0:  # all costs equal: lambda is irrelevant
        return np.array([0.0])
    lam_max = 1.5 / float(gaps.min())
    grid = np.geomspace(lam_max * 1e-7, lam_max, n_points - 1)
    return np.concatenate([[0.0], grid])


def pareto_clean(costs: np.ndarray, qualities: np.ndarray) -> DeferralCurve:
    """Drop points that cost more without being better; sort by cost."""
    costs = np.asarray(costs, dtype=np.float64)
    qualities = np.asarray(qualities, dtype=np.float64)
    order = np.lexsort((-qualities, costs))
    kept_costs: list[float] = []
    kept_quality: list[float] = []
    best = -np.inf
    for i in order:
        if qualities[i] > best:
            kept_costs.append(float(costs[i]))
            kept_quality.append(float(qualities[i]))
            best = float(qualities[i])
    return DeferralCurve(costs=np.array(kept_costs), qualities=np.array(kept_quality))


def deferral_curve(
    gamma: np.ndarray,
    test_errors: np.ndarray,
    costs: np.ndarray,
    *,
    lambdas: Sequence[float] | None = None,
) -> DeferralCurve:
    """Sweep lambda through the plug-in rule (eq. 9) and trace the trade-off.

    Args:
        gamma: (n_prompts, n_llms) predicted error probabilities on the
            *test* prompts for the *test* LLM pool.
        test_errors: (n_prompts, n_llms) realised 0-1 losses, used only to
            score the routed decisions (never to make them).
        costs: (n_llms,) per-prompt costs.
        lambdas: optional explicit sweep; defaults to ``default_lambda_grid``.
    """
    test_errors = np.asarray(test_errors, dtype=np.float64)
    costs = np.asarray(costs, dtype=np.float64)
    grid = default_lambda_grid(costs) if lambdas is None else np.asarray(lambdas)
    n_prompts = test_errors.shape[0]
    point_costs = np.empty(grid.shape[0])
    point_quality = np.empty(grid.shape[0])
    rows = np.arange(n_prompts)
    for j, lam in enumerate(grid):
        choices = route(gamma, costs, float(lam))
        point_costs[j] = float(costs[choices].mean())
        point_quality[j] = float(1.0 - test_errors[rows, choices].mean())
    return pareto_clean(point_costs, point_quality)


def zero_router_curve(
    zero: ZeroRouter,
    test_errors: np.ndarray,
    costs: np.ndarray,
    *,
    n_budgets: int = 64,
) -> DeferralCurve:
    """The ZeroRouter trade-off, evaluated in expectation (no sampling).

    The mixture is chosen on the validation sample inside ``zero``; here each
    budget's plan is scored against the test error rates analytically:
    expected quality = (1-w) q_low + w q_high.
    """
    test_errors = np.asarray(test_errors, dtype=np.float64)
    costs = np.asarray(costs, dtype=np.float64)
    test_quality = 1.0 - test_errors.mean(axis=0)
    frontier = zero.frontier
    lo, hi = float(costs[frontier[0]]), float(costs[frontier[-1]])
    budgets = np.linspace(lo, hi, n_budgets) if hi > lo else np.array([lo])
    point_costs = np.empty(budgets.shape[0])
    point_quality = np.empty(budgets.shape[0])
    for j, budget in enumerate(budgets):
        plan = zero.plan(float(budget))
        point_costs[j] = plan.expected(costs)
        point_quality[j] = plan.expected(test_quality)
    return pareto_clean(point_costs, point_quality)


def area_under_curve(
    curve: DeferralCurve, max_cost: float, *, up_to: float = 1.0
) -> float:
    """Average quality over normalised cost in [0, up_to].

    The cost axis is normalised by ``max_cost`` (the most expensive LLM in
    the pool). The curve extends flat on both ends, so the value reads as
    "expected quality if a budget were drawn uniformly from [0, up_to]".
    """
    if max_cost <= 0:
        raise ValueError("max_cost must be positive")
    if not 0.0 < up_to <= 1.0:
        raise ValueError("up_to must be in (0, 1]")
    normalised = curve.costs / max_cost
    target = up_to
    # Integration nodes: segment breakpoints inside [0, target] plus the ends.
    inner = normalised[(normalised > 0.0) & (normalised < target)]
    nodes = np.concatenate([[0.0], inner, [target]])
    values = np.interp(nodes, normalised, curve.qualities)
    return float(np.trapezoid(values, nodes) / target)


def quality_neutral_cost(curve: DeferralCurve, test_errors: np.ndarray, costs: np.ndarray) -> float:
    """QNC: minimum relative cost to match the most accurate LLM.

    Relative to the cost of that most accurate LLM; ``inf`` when the router
    never reaches its quality. Values < 1 mean the router matches the best
    model at a fraction of its cost.
    """
    test_errors = np.asarray(test_errors, dtype=np.float64)
    costs = np.asarray(costs, dtype=np.float64)
    quality = 1.0 - test_errors.mean(axis=0)
    best = int(quality.argmax())
    target = float(quality[best])
    reference_cost = float(costs[best])
    if curve.qualities.max() < target:
        return float("inf")
    # Walk the piecewise-linear curve for the first crossing of the target.
    for i in range(curve.costs.shape[0]):
        if curve.qualities[i] >= target:
            if i == 0:
                return float(curve.costs[0] / reference_cost)
            c0, c1 = curve.costs[i - 1], curve.costs[i]
            q0, q1 = curve.qualities[i - 1], curve.qualities[i]
            frac = (target - q0) / (q1 - q0) if q1 > q0 else 1.0
            return float((c0 + frac * (c1 - c0)) / reference_cost)
    raise AssertionError("unreachable: max quality was checked above")


def select_n_clusters(
    candidates: Sequence[int],
    train_embeddings: np.ndarray,
    train_errors: np.ndarray,
    val_embeddings: np.ndarray,
    val_errors: np.ndarray,
    costs: np.ndarray,
    *,
    seed: int = 0,
    make_router: Callable[[int, int], UniRouteKMeans] | None = None,
) -> int:
    """Pick K by the Appendix F.1 procedure.

    For each candidate K: fit on the training prompts, represent the
    *training* LLMs via their training-set labels, route them on the
    validation prompts, and measure the area under the deferral curve. The
    K with the largest area wins. Only training-pool labels are consumed, so
    the choice is legitimate under a dynamic pool.
    """
    costs = np.asarray(costs, dtype=np.float64)
    max_cost = float(costs.max())
    best_k: int | None = None
    best_area = -np.inf
    for k in candidates:
        router = (
            UniRouteKMeans(k, seed=seed) if make_router is None else make_router(k, seed)
        )
        router.fit(train_embeddings)
        psi = router.embed_llms(train_embeddings, train_errors)
        gamma = router.gamma(val_embeddings, psi)
        curve = deferral_curve(gamma, val_errors, costs)
        area = area_under_curve(curve, max_cost)
        if area > best_area:
            best_area = area
            best_k = k
    assert best_k is not None, "candidates must be non-empty"
    return best_k
