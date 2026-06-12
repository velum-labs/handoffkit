"""Seeded k-means with k-means++ initialisation (NumPy only).

UniRoute (S 5.1) clusters the *training* prompt embeddings to obtain the
cluster assignment map Phi_clust. Determinism matters more than raw speed
here: the router must be reproducible from a seed, so we use a single
k-means++ initialisation from a caller-supplied seed rather than scikit-style
multi-restart.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class KMeansResult:
    """Fitted centroids plus the assignment of each training point."""

    centroids: np.ndarray  # (n_clusters, n_dims)
    labels: np.ndarray  # (n_points,) int
    inertia: float
    n_iter: int


def _squared_distances(points: np.ndarray, centroids: np.ndarray) -> np.ndarray:
    """Pairwise squared Euclidean distances, (n_points, n_clusters)."""
    # ||x - c||^2 = ||x||^2 - 2 x.c + ||c||^2; the x^2 term is constant per
    # row but kept so the values are true distances (used for inertia).
    cross = points @ centroids.T
    p_sq = np.einsum("ij,ij->i", points, points)[:, None]
    c_sq = np.einsum("ij,ij->i", centroids, centroids)[None, :]
    return np.maximum(p_sq - 2.0 * cross + c_sq, 0.0)


def _kmeans_plus_plus(
    points: np.ndarray, n_clusters: int, rng: np.random.Generator
) -> np.ndarray:
    n_points = points.shape[0]
    centroids = np.empty((n_clusters, points.shape[1]), dtype=np.float64)
    first = int(rng.integers(n_points))
    centroids[0] = points[first]
    closest = _squared_distances(points, centroids[:1])[:, 0]
    for k in range(1, n_clusters):
        total = float(closest.sum())
        if total <= 0.0:
            # All remaining points coincide with chosen centroids; any pick works.
            choice = int(rng.integers(n_points))
        else:
            choice = int(rng.choice(n_points, p=closest / total))
        centroids[k] = points[choice]
        closest = np.minimum(closest, _squared_distances(points, centroids[k : k + 1])[:, 0])
    return centroids


def kmeans(
    points: np.ndarray,
    n_clusters: int,
    *,
    seed: int = 0,
    max_iter: int = 100,
    tol: float = 1e-7,
) -> KMeansResult:
    """Lloyd's algorithm with k-means++ seeding.

    Empty clusters are re-seeded to the point currently farthest from its
    centroid, so the result always has exactly ``n_clusters`` non-degenerate
    centroids (as long as there are at least that many distinct points).
    """
    points = np.asarray(points, dtype=np.float64)
    if points.ndim != 2:
        raise ValueError("points must be a 2-D array (n_points, n_dims)")
    n_points = points.shape[0]
    if not 1 <= n_clusters <= n_points:
        raise ValueError(f"n_clusters must be in [1, {n_points}], got {n_clusters}")

    rng = np.random.default_rng(seed)
    centroids = _kmeans_plus_plus(points, n_clusters, rng)
    labels = np.zeros(n_points, dtype=np.int64)
    n_iter = 0
    for n_iter in range(1, max_iter + 1):
        distances = _squared_distances(points, centroids)
        labels = distances.argmin(axis=1)
        new_centroids = np.empty_like(centroids)
        per_point_min = distances[np.arange(n_points), labels]
        for k in range(n_clusters):
            members = points[labels == k]
            if members.shape[0] == 0:
                # Re-seed an empty cluster at the worst-served point.
                new_centroids[k] = points[int(per_point_min.argmax())]
                per_point_min = per_point_min.copy()
                per_point_min[int(per_point_min.argmax())] = 0.0
            else:
                new_centroids[k] = members.mean(axis=0)
        shift = float(np.linalg.norm(new_centroids - centroids))
        centroids = new_centroids
        if shift < tol:
            break

    distances = _squared_distances(points, centroids)
    labels = distances.argmin(axis=1)
    inertia = float(distances[np.arange(n_points), labels].sum())
    return KMeansResult(centroids=centroids, labels=labels, inertia=inertia, n_iter=n_iter)


def assign(points: np.ndarray, centroids: np.ndarray) -> np.ndarray:
    """Hard cluster assignment: index of the nearest centroid per point."""
    points = np.asarray(points, dtype=np.float64)
    return _squared_distances(points, centroids).argmin(axis=1)
