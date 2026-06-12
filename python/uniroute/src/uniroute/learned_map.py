"""UniRoute with a learned cluster assignment map (S 5.2).

The unsupervised router (S 5.1) ignores the correctness labels available in
the training set for the *training* LLM pool. This variant keeps the same
per-cluster LLM representation Psi_clust (eq. 13) but replaces the hard
k-means assignment with a learned soft map

    Phi_clust,k(x; theta)  proportional to  exp(theta_k . phi(x)),

fitted by minimising the log loss of gamma(x, h; theta) = Phi(x; theta) . Psi(h)
against the 0-1 correctness labels of the training LLMs on the training set.

At test time nothing changes for new LLMs: they are still represented by
their per-cluster validation errors under the *same* clustering, so the
learned map generalises to a dynamic pool exactly like the k-means variant.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .kmeans import kmeans
from .routers import cluster_error_embedding, route

_EPS = 1e-7


def _augment(embeddings: np.ndarray) -> np.ndarray:
    """Append a constant-1 feature so theta can carry a per-cluster bias.

    The softmax-of-distances initialisation needs a -||mu_k||^2 offset
    (see ``_init_theta``); hosting it as a bias keeps the model exactly the
    paper's linear form in an augmented embedding.
    """
    embeddings = np.asarray(embeddings, dtype=np.float64)
    ones = np.ones((embeddings.shape[0], 1), dtype=np.float64)
    return np.concatenate([embeddings, ones], axis=1)


def _softmax(logits: np.ndarray) -> np.ndarray:
    shifted = logits - logits.max(axis=1, keepdims=True)
    exp = np.exp(shifted)
    return exp / exp.sum(axis=1, keepdims=True)


def _init_theta(centroids: np.ndarray, train_embeddings: np.ndarray) -> np.ndarray:
    """Initialise theta so the soft map starts at the k-means assignment.

    With logits (2 mu_k . x - ||mu_k||^2) / tau the softmax equals the
    soft-min of squared distances ||x - mu_k||^2 / tau (the ||x||^2 term is
    constant across k). tau is set to the mean within-cluster squared
    distance, giving O(1) logits to start gradient descent from.
    """
    diffs = train_embeddings[:, None, :] - centroids[None, :, :]
    sq = np.einsum("ikd,ikd->ik", diffs, diffs)
    tau = float(np.maximum(sq.min(axis=1).mean(), 1e-12))
    weights = 2.0 * centroids / tau
    bias = -np.einsum("kd,kd->k", centroids, centroids) / tau
    return np.concatenate([weights, bias[:, None]], axis=1)


def loss_and_grad(
    theta: np.ndarray,
    features: np.ndarray,
    errors: np.ndarray,
    psi_t: np.ndarray,
) -> tuple[float, np.ndarray]:
    """Mean log loss of gamma = softmax(features theta^T) psi_t, and d/d theta.

    Exposed as a module function so the analytic gradient can be verified
    against finite differences in the test suite.
    """
    n_prompts = features.shape[0]
    phi = _softmax(features @ theta.T)  # (n, K)
    gamma = np.clip(phi @ psi_t, _EPS, 1.0 - _EPS)  # (n, M)
    loss = -(errors * np.log(gamma) + (1.0 - errors) * np.log(1.0 - gamma)).mean()

    d_gamma = (gamma - errors) / (gamma * (1.0 - gamma))  # dL/dgamma * (n*M)
    d_phi = d_gamma @ psi_t.T  # (n, K)
    # Softmax Jacobian: dL/dz_k = phi_k * (g_k - sum_j phi_j g_j).
    inner = (phi * d_phi).sum(axis=1, keepdims=True)
    d_logits = phi * (d_phi - inner)
    grad = (d_logits.T @ features) / (n_prompts * errors.shape[1])
    return float(loss), grad


@dataclass(frozen=True)
class TrainingTrace:
    """Log-loss trajectory of the gradient descent, for tests and demos."""

    losses: list[float]

    @property
    def initial(self) -> float:
        return self.losses[0]

    @property
    def final(self) -> float:
        return self.losses[-1]


class UniRouteLearnedMap:
    """UniRoute with a supervised softmax cluster assignment map (S 5.2).

    ``fit`` runs k-means first (the clustering also defines Psi for new
    LLMs), then full-batch Adam on the log loss of the training LLM pool.
    ``psi_embeddings``/``psi_errors`` choose the sample used to build
    Psi_clust for the *training* LLMs during fitting (the paper uses the
    validation set; defaults to the training set when omitted, which uses
    strictly more labels).
    """

    def __init__(
        self,
        n_clusters: int,
        *,
        seed: int = 0,
        learning_rate: float = 0.05,
        epochs: int = 300,
    ):
        if n_clusters < 1:
            raise ValueError("n_clusters must be >= 1")
        self.n_clusters = n_clusters
        self.seed = seed
        self.learning_rate = learning_rate
        self.epochs = epochs
        self._centroids: np.ndarray | None = None
        self._theta: np.ndarray | None = None
        self.trace: TrainingTrace | None = None

    @property
    def centroids(self) -> np.ndarray:
        if self._centroids is None:
            raise RuntimeError("router is not fitted; call fit() first")
        return self._centroids

    @property
    def theta(self) -> np.ndarray:
        if self._theta is None:
            raise RuntimeError("router is not fitted; call fit() first")
        return self._theta

    def fit(
        self,
        train_embeddings: np.ndarray,
        train_errors: np.ndarray,
        *,
        psi_embeddings: np.ndarray | None = None,
        psi_errors: np.ndarray | None = None,
    ) -> "UniRouteLearnedMap":
        train_embeddings = np.asarray(train_embeddings, dtype=np.float64)
        train_errors = np.asarray(train_errors, dtype=np.float64)
        if train_embeddings.shape[0] != train_errors.shape[0]:
            raise ValueError("train_embeddings and train_errors must cover the same prompts")
        if (psi_embeddings is None) != (psi_errors is None):
            raise ValueError("psi_embeddings and psi_errors must be provided together")

        result = kmeans(train_embeddings, self.n_clusters, seed=self.seed)
        self._centroids = result.centroids

        # Psi for the training LLMs, fixed during gradient descent (S 5.2:
        # "note that this does not depend on theta").
        if psi_embeddings is None:
            psi_ids = result.labels
            psi_source_errors = train_errors
        else:
            psi_ids = self._cluster_ids(np.asarray(psi_embeddings, dtype=np.float64))
            psi_source_errors = np.asarray(psi_errors, dtype=np.float64)
        psi = cluster_error_embedding(psi_ids, psi_source_errors, self.n_clusters)

        features = _augment(train_embeddings)
        theta = _init_theta(self._centroids, train_embeddings)
        psi_t = psi.T  # (K, n_llms)

        # Full-batch Adam on the log loss; the problem is small (K x (D+1)
        # parameters) and deterministic full-batch descent keeps the fit
        # reproducible from the seed alone.
        m_t = np.zeros_like(theta)
        v_t = np.zeros_like(theta)
        beta1, beta2, adam_eps = 0.9, 0.999, 1e-8
        losses: list[float] = []
        for step in range(1, self.epochs + 1):
            loss, grad = loss_and_grad(theta, features, train_errors, psi_t)
            losses.append(loss)

            m_t = beta1 * m_t + (1.0 - beta1) * grad
            v_t = beta2 * v_t + (1.0 - beta2) * grad * grad
            m_hat = m_t / (1.0 - beta1**step)
            v_hat = v_t / (1.0 - beta2**step)
            theta = theta - self.learning_rate * m_hat / (np.sqrt(v_hat) + adam_eps)

        self._theta = theta
        self.trace = TrainingTrace(losses=losses)
        return self

    def _cluster_ids(self, embeddings: np.ndarray) -> np.ndarray:
        diffs = embeddings[:, None, :] - self.centroids[None, :, :]
        return np.einsum("ikd,ikd->ik", diffs, diffs).argmin(axis=1)

    def assignment(self, embeddings: np.ndarray) -> np.ndarray:
        """The learned soft map Phi_clust(x; theta), rows sum to 1."""
        return _softmax(_augment(embeddings) @ self.theta.T)

    def embed_llms(self, val_embeddings: np.ndarray, val_errors: np.ndarray) -> np.ndarray:
        """Psi_clust for new LLMs (eq. 13), under the k-means clustering.

        Cluster membership for Psi stays the hard k-means assignment: Psi is
        defined by the clustering, not by theta, so a new LLM's embedding is
        identical to what the unsupervised variant would compute.
        """
        ids = self._cluster_ids(np.asarray(val_embeddings, dtype=np.float64))
        return cluster_error_embedding(ids, val_errors, self.n_clusters)

    def gamma(self, embeddings: np.ndarray, psi: np.ndarray) -> np.ndarray:
        psi = np.asarray(psi, dtype=np.float64)
        if psi.ndim != 2 or psi.shape[1] != self.n_clusters:
            raise ValueError(f"psi must be (n_llms, {self.n_clusters})")
        return self.assignment(embeddings) @ psi.T

    def route(
        self, embeddings: np.ndarray, psi: np.ndarray, costs: np.ndarray, lam: float
    ) -> np.ndarray:
        return route(self.gamma(embeddings, psi), costs, lam)
