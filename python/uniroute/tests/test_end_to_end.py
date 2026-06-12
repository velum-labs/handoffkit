"""End-to-end checks of the paper's headline claims on the synthetic benchmark.

All routing over the TEST LLM pool uses only (i) unlabelled training prompts,
(ii) the small labelled validation set, never the test pool's test-set labels.
"""

import numpy as np

from uniroute import (
    UniRouteKMeans,
    area_under_curve,
    deferral_curve,
    select_n_clusters,
)
from uniroute.synthetic import make_benchmark
from uniroute.trials import synthetic_trial_curves

N_TRIALS = 4

# Short keys per paper method name, as the assertions below read them.
METHOD_KEYS = {
    "ZeroRouter": "zero",
    "K-NN": "knn",
    "UniRoute (K-means)": "kmeans",
    "UniRoute (LearnedMap)": "learned",
    "Oracle (clairvoyant)": "oracle",
}


def trial_areas(seed: int) -> dict[str, float]:
    bench = make_benchmark(n_prompts=3000, n_topics=6, n_llms=12, seed=seed)
    max_cost = float(bench.test_pool_costs.max())
    curves = synthetic_trial_curves(bench, 8, seed, epochs=150)
    return {
        METHOD_KEYS[name]: area_under_curve(curve, max_cost)
        for name, curve in curves.items()
    }


def mean_areas() -> dict[str, float]:
    sums: dict[str, float] = {}
    for seed in range(N_TRIALS):
        for name, value in trial_areas(seed).items():
            sums[name] = sums.get(name, 0.0) + value
    return {name: total / N_TRIALS for name, total in sums.items()}


AREAS = mean_areas()


def test_uniroute_beats_zero_router():
    # The paper's consistent finding across all four datasets (S 7.2).
    assert AREAS["kmeans"] > AREAS["zero"] + 0.01


def test_uniroute_at_least_matches_knn_with_a_small_validation_set():
    # Figure 2 (bottom): K-means UniRoute dominates K-NN at small val sizes
    # because it shapes clusters on the large unlabelled training set.
    assert AREAS["kmeans"] >= AREAS["knn"] - 0.005


def test_learned_map_at_least_matches_kmeans():
    # Figure 2 (top): LearnedMap is on par with or slightly better than
    # K-means UniRoute.
    assert AREAS["learned"] >= AREAS["kmeans"] - 0.01


def test_oracle_upper_bounds_everything():
    for name in ("zero", "knn", "kmeans", "learned"):
        assert AREAS["oracle"] >= AREAS[name] - 1e-6


def test_routing_beats_every_single_model_quality_per_cost():
    # At the best single model's cost, the routed curve should reach at least
    # that model's quality (deferral dominance at the top end).
    bench = make_benchmark(n_prompts=3000, n_topics=6, n_llms=12, seed=10)
    costs = bench.test_pool_costs
    errors = bench.test_errors_test_pool
    km = UniRouteKMeans(8, seed=10).fit(bench.train_embeddings)
    psi = km.embed_llms(bench.val_embeddings, bench.val_errors_test_pool)
    curve = deferral_curve(km.gamma(bench.test_embeddings, psi), errors, costs)
    quality = 1.0 - errors.mean(axis=0)
    best = int(quality.argmax())
    assert curve.quality_at(float(costs[best])) >= float(quality[best]) - 0.02


def test_select_n_clusters_uses_only_training_pool_labels():
    bench = make_benchmark(n_prompts=2000, seed=5)
    chosen = select_n_clusters(
        [2, 4, 8],
        bench.train_embeddings,
        bench.train_errors_train_pool,
        bench.val_embeddings,
        bench.val_errors_train_pool,
        bench.train_pool_costs,
        seed=5,
    )
    assert chosen in (2, 4, 8)
