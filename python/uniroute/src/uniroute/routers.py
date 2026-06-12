"""UniRoute routers and baselines.

Implements the plug-in routing rule and the estimators of the per-prompt,
per-LLM error probability gamma(x, h) from arXiv:2502.08773v2:

- ``route``:            r(x, H) = argmin_m [gamma(x, h_m) + lambda * c(h_m)]   (eq. 9)
- ``UniRouteKMeans``:   gamma_clust(x, h) = Phi_clust(x) . Psi_clust(h)        (S 5.1, eqs. 12-13)
- ``KNNRouter``:        gamma_kNN(x, h)  = mean error over k nearest
                        validation prompts                                     (eq. 5)
- ``ZeroRouter``:       prompt-independent randomisation between two LLMs
                        chosen on the validation sample                        (Appendix D)

The learned cluster assignment map (S 5.2) lives in ``learned_map.py``.

Conventions used throughout the package:

- ``embeddings`` are float arrays of shape (n_prompts, n_dims).
- ``errors`` are arrays of shape (n_prompts, n_llms) with values in [0, 1];
  entry (i, m) is the 0-1 loss of LLM m on prompt i (1 = wrong). This is the
  prediction error vector representation of S 4.2.
- ``costs`` is a (n_llms,) array of per-prompt inference costs c(h).

A dynamic pool needs no retraining: fit a router once on the training
prompts, then represent any new LLM with ``embed_llms`` on a small labelled
validation set and route immediately.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .kmeans import assign, kmeans


def route(gamma: np.ndarray, costs: np.ndarray, lam: float) -> np.ndarray:
    """The plug-in routing rule (eq. 9).

    Picks, per prompt, the LLM minimising the cost-adjusted predicted error
    ``gamma + lam * cost``. Ties break toward the cheaper LLM (then lower
    index), which keeps the lambda -> infinity limit exactly "cheapest model".

    Args:
        gamma: (n_prompts, n_llms) predicted error probabilities.
        costs: (n_llms,) per-prompt costs.
        lam: trade-off multiplier lambda >= 0.

    Returns:
        (n_prompts,) integer indices into the LLM pool.
    """
    gamma = np.asarray(gamma, dtype=np.float64)
    costs = np.asarray(costs, dtype=np.float64)
    if gamma.ndim != 2 or gamma.shape[1] != costs.shape[0]:
        raise ValueError("gamma must be (n_prompts, n_llms) matching costs")
    if lam < 0:
        raise ValueError("lambda must be >= 0")
    adjusted = gamma + lam * costs[None, :]
    # Stable, cost-aware tie-breaking: order candidates by (score, cost, index).
    order = np.lexsort((np.arange(costs.shape[0]), costs))
    best_in_order = adjusted[:, order].argmin(axis=1)
    return order[best_in_order]


def cluster_error_embedding(
    cluster_ids: np.ndarray, errors: np.ndarray, n_clusters: int
) -> np.ndarray:
    """Per-cluster mean errors Psi_clust(h) for every LLM (eq. 13).

    Args:
        cluster_ids: (n_prompts,) cluster index of each validation prompt.
        errors: (n_prompts, n_llms) 0-1 losses on the validation set.
        n_clusters: number of clusters K.

    Returns:
        (n_llms, K) matrix; row m is Psi_clust(h_m). A cluster with no
        validation prompts falls back to the LLM's overall validation error
        (the best label-free estimate available for that cluster).
    """
    errors = np.asarray(errors, dtype=np.float64)
    if errors.ndim != 2:
        raise ValueError("errors must be (n_prompts, n_llms)")
    if cluster_ids.shape[0] != errors.shape[0]:
        raise ValueError("cluster_ids and errors must cover the same prompts")
    n_llms = errors.shape[1]
    psi = np.empty((n_llms, n_clusters), dtype=np.float64)
    overall = errors.mean(axis=0)
    for k in range(n_clusters):
        members = errors[cluster_ids == k]
        psi[:, k] = overall if members.shape[0] == 0 else members.mean(axis=0)
    return psi


class UniRouteKMeans:
    """UniRoute with an unsupervised cluster assignment map (S 5.1).

    Step 1 (``fit``): k-means on training prompt embeddings; no labels used.
    Step 2 (``embed_llms``): represent each LLM -- including ones never seen
    during training -- by its per-cluster mean error on a small validation
    set (eq. 13).
    Step 3 (``gamma`` + ``route``): estimate each LLM's error on a new prompt
    as its mean error on the prompt's cluster, and pick the argmin of the
    cost-adjusted estimate (eqs. 12 and 9).
    """

    def __init__(self, n_clusters: int, *, seed: int = 0):
        if n_clusters < 1:
            raise ValueError("n_clusters must be >= 1")
        self.n_clusters = n_clusters
        self.seed = seed
        self._centroids: np.ndarray | None = None

    @property
    def centroids(self) -> np.ndarray:
        if self._centroids is None:
            raise RuntimeError("router is not fitted; call fit() first")
        return self._centroids

    def fit(self, train_embeddings: np.ndarray) -> "UniRouteKMeans":
        result = kmeans(train_embeddings, self.n_clusters, seed=self.seed)
        self._centroids = result.centroids
        return self

    def cluster_ids(self, embeddings: np.ndarray) -> np.ndarray:
        """Hard cluster assignment (the one-hot Phi_clust, as indices)."""
        return assign(embeddings, self.centroids)

    def assignment(self, embeddings: np.ndarray) -> np.ndarray:
        """Phi_clust as explicit one-hot rows, (n_prompts, K)."""
        ids = self.cluster_ids(embeddings)
        one_hot = np.zeros((ids.shape[0], self.n_clusters), dtype=np.float64)
        one_hot[np.arange(ids.shape[0]), ids] = 1.0
        return one_hot

    def embed_llms(self, val_embeddings: np.ndarray, val_errors: np.ndarray) -> np.ndarray:
        """Psi_clust for every column of ``val_errors``, (n_llms, K)."""
        ids = self.cluster_ids(val_embeddings)
        return cluster_error_embedding(ids, val_errors, self.n_clusters)

    def gamma(self, embeddings: np.ndarray, psi: np.ndarray) -> np.ndarray:
        """gamma_clust(x, h) = Phi_clust(x) . Psi_clust(h), (n_prompts, n_llms)."""
        psi = np.asarray(psi, dtype=np.float64)
        if psi.ndim != 2 or psi.shape[1] != self.n_clusters:
            raise ValueError(f"psi must be (n_llms, {self.n_clusters})")
        ids = self.cluster_ids(embeddings)
        return psi.T[ids]

    def route(
        self, embeddings: np.ndarray, psi: np.ndarray, costs: np.ndarray, lam: float
    ) -> np.ndarray:
        return route(self.gamma(embeddings, psi), costs, lam)


class KNNRouter:
    """The k-NN router of Hu et al. (2024b) (eq. 5).

    A special case of UniRoute (S 4.2): Psi is the raw prediction error
    vector on the validation set and Phi(x) indicates x's k nearest
    validation prompts. Supports dynamic pools for the same reason UniRoute
    does -- a new LLM only needs its validation error vector -- but cannot
    exploit the (larger, unlabelled-for-new-LLMs) training set at all.
    """

    def __init__(self, n_neighbors: int):
        if n_neighbors < 1:
            raise ValueError("n_neighbors must be >= 1")
        self.n_neighbors = n_neighbors
        self._val_embeddings: np.ndarray | None = None
        self._val_errors: np.ndarray | None = None

    def fit(self, val_embeddings: np.ndarray, val_errors: np.ndarray) -> "KNNRouter":
        val_embeddings = np.asarray(val_embeddings, dtype=np.float64)
        val_errors = np.asarray(val_errors, dtype=np.float64)
        if val_embeddings.shape[0] != val_errors.shape[0]:
            raise ValueError("val_embeddings and val_errors must cover the same prompts")
        if self.n_neighbors > val_embeddings.shape[0]:
            raise ValueError("n_neighbors exceeds the number of validation prompts")
        self._val_embeddings = val_embeddings
        self._val_errors = val_errors
        return self

    def gamma(self, embeddings: np.ndarray) -> np.ndarray:
        if self._val_embeddings is None or self._val_errors is None:
            raise RuntimeError("router is not fitted; call fit() first")
        embeddings = np.asarray(embeddings, dtype=np.float64)
        cross = embeddings @ self._val_embeddings.T
        e_sq = np.einsum("ij,ij->i", embeddings, embeddings)[:, None]
        v_sq = np.einsum("ij,ij->i", self._val_embeddings, self._val_embeddings)[None, :]
        distances = e_sq - 2.0 * cross + v_sq
        neighbors = np.argpartition(distances, self.n_neighbors - 1, axis=1)[
            :, : self.n_neighbors
        ]
        return self._val_errors[neighbors].mean(axis=1)

    def route(self, embeddings: np.ndarray, costs: np.ndarray, lam: float) -> np.ndarray:
        return route(self.gamma(embeddings), costs, lam)


@dataclass(frozen=True)
class ZeroRouterPlan:
    """A budget-feasible randomisation between (at most) two LLMs."""

    low_index: int
    high_index: int
    high_weight: float  # probability of routing to high_index

    def expected(self, per_llm_values: np.ndarray) -> float:
        """Expected value of any per-LLM statistic under this mixture."""
        values = np.asarray(per_llm_values, dtype=np.float64)
        w = self.high_weight
        return float((1.0 - w) * values[self.low_index] + w * values[self.high_index])


class ZeroRouter:
    """Prompt-independent random routing (Appendix D; Hu et al. 2024b).

    Ignores the prompt entirely. On the validation sample it computes each
    LLM's (cost, quality) and keeps the upper concave envelope; for a budget
    B it randomises between the two envelope LLMs bracketing B with the
    mixing weight that meets the budget exactly. Equivalent to UniRoute with
    K = 1 cluster swept over budgets.
    """

    def __init__(self) -> None:
        self._costs: np.ndarray | None = None
        self._frontier: list[int] | None = None
        self._frontier_quality: np.ndarray | None = None

    def fit(self, costs: np.ndarray, val_errors: np.ndarray) -> "ZeroRouter":
        costs = np.asarray(costs, dtype=np.float64)
        quality = 1.0 - np.asarray(val_errors, dtype=np.float64).mean(axis=0)
        if costs.shape[0] != quality.shape[0]:
            raise ValueError("costs and val_errors must describe the same LLMs")
        # Upper concave envelope of (cost, quality), left to right.
        order = sorted(range(costs.shape[0]), key=lambda m: (costs[m], -quality[m]))
        hull: list[int] = []
        for m in order:
            if hull and costs[m] == costs[hull[-1]]:
                continue  # same cost, lower-or-equal quality: dominated
            if hull and quality[m] <= quality[hull[-1]]:
                continue  # costs more and is no better: dominated
            while len(hull) >= 2:
                a, b = hull[-2], hull[-1]
                slope_ab = (quality[b] - quality[a]) / (costs[b] - costs[a])
                slope_bm = (quality[m] - quality[b]) / (costs[m] - costs[b])
                if slope_bm >= slope_ab:
                    hull.pop()  # b lies under the chord a -> m
                else:
                    break
            hull.append(m)
        self._costs = costs
        self._frontier = hull
        self._frontier_quality = quality[hull]
        return self

    @property
    def frontier(self) -> list[int]:
        if self._frontier is None:
            raise RuntimeError("router is not fitted; call fit() first")
        return list(self._frontier)

    def plan(self, budget: float) -> ZeroRouterPlan:
        """The quality-maximising feasible mixture for a per-prompt budget."""
        if self._costs is None or self._frontier is None:
            raise RuntimeError("router is not fitted; call fit() first")
        frontier = self._frontier
        costs = self._costs
        cheapest = frontier[0]
        if budget < costs[cheapest]:
            raise ValueError(
                f"budget {budget} is below the cheapest LLM cost {costs[cheapest]}"
            )
        if budget >= costs[frontier[-1]]:
            best = frontier[-1]
            return ZeroRouterPlan(low_index=best, high_index=best, high_weight=1.0)
        for low, high in zip(frontier, frontier[1:]):
            if costs[low] <= budget < costs[high]:
                weight = (budget - costs[low]) / (costs[high] - costs[low])
                return ZeroRouterPlan(
                    low_index=low, high_index=high, high_weight=float(weight)
                )
        raise AssertionError("budget bracketing failed; frontier is inconsistent")

    def sample(self, budget: float, n_prompts: int, *, seed: int = 0) -> np.ndarray:
        """Sample per-prompt LLM choices under the budget-feasible mixture."""
        plan = self.plan(budget)
        rng = np.random.default_rng(seed)
        high = rng.random(n_prompts) < plan.high_weight
        return np.where(high, plan.high_index, plan.low_index)
