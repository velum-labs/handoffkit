"""UniRoute: universal model routing for efficient LLM inference.

A NumPy implementation of arXiv:2502.08773v2 (Jitkrittum et al., 2025):
routing prompts over a *dynamic* pool of LLMs by representing each LLM as a
feature vector of prediction errors on a small validation set, so new LLMs
can be routed to without retraining the router.
"""

from .evaluate import (
    DeferralCurve,
    area_under_curve,
    deferral_curve,
    default_lambda_grid,
    pareto_clean,
    quality_neutral_cost,
    select_n_clusters,
    zero_router_curve,
)
from .kmeans import KMeansResult, assign, kmeans
from .learned_map import TrainingTrace, UniRouteLearnedMap
from .routers import (
    KNNRouter,
    RoutingDecision,
    UniRouteKMeans,
    ZeroRouter,
    ZeroRouterPlan,
    cluster_error_embedding,
    route,
)
from .synthetic import SyntheticBenchmark, make_benchmark

__all__ = [
    "DeferralCurve",
    "KMeansResult",
    "KNNRouter",
    "RoutingDecision",
    "SyntheticBenchmark",
    "TrainingTrace",
    "UniRouteKMeans",
    "UniRouteLearnedMap",
    "ZeroRouter",
    "ZeroRouterPlan",
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
