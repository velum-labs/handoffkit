"""UniRoute: universal model routing for efficient LLM inference.

A NumPy implementation of arXiv:2502.08773v2 (Jitkrittum et al., 2025):
routing prompts over a *dynamic* pool of LLMs by representing each LLM as a
feature vector of prediction errors on a small validation set, so new LLMs
can be routed to without retraining the router.
"""

from .evaluate import (
    DeferralCurve,
    area_under_curve,
    default_lambda_grid,
    deferral_curve,
    pareto_clean,
    quality_neutral_cost,
    select_n_clusters,
    zero_router_curve,
)
from .kmeans import assign, kmeans
from .learned_map import UniRouteLearnedMap
from .routers import (
    KNNRouter,
    UniRouteKMeans,
    ZeroRouter,
    cluster_error_embedding,
    route,
)
from .synthetic import make_benchmark

__all__ = [
    "DeferralCurve",
    "KNNRouter",
    "UniRouteKMeans",
    "UniRouteLearnedMap",
    "ZeroRouter",
    "area_under_curve",
    "assign",
    "cluster_error_embedding",
    "default_lambda_grid",
    "deferral_curve",
    "kmeans",
    "make_benchmark",
    "pareto_clean",
    "quality_neutral_cost",
    "route",
    "select_n_clusters",
    "zero_router_curve",
]
