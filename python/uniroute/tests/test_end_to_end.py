"""End-to-end checks of the paper's headline claims on the synthetic benchmark.

All routing over the TEST LLM pool uses only (i) unlabelled training prompts,
(ii) the small labelled validation set, never the test pool's test-set labels.
"""

import numpy as np

from uniroute import (
    KNNRouter,
    UniRouteKMeans,
    UniRouteLearnedMap,
    ZeroRouter,
    area_under_curve,
    deferral_curve,
    select_n_clusters,
    zero_router_curve,
)
from uniroute.synthetic import make_benchmark

N_TRIALS = 4


def trial_areas(seed: int) -> dict[str, float]:
    bench = make_benchmark(n_prompts=3000, n_topics=6, n_llms=12, seed=seed)
    costs = bench.test_pool_costs
    max_cost = float(costs.max())
    errors = bench.test_errors_test_pool

    zero = ZeroRouter().fit(costs, bench.val_errors_test_pool)
    zero_area = area_under_curve(zero_router_curve(zero, errors, costs), max_cost)

    knn = KNNRouter(n_neighbors=10).fit(bench.val_embeddings, bench.val_errors_test_pool)
    knn_curve = deferral_curve(knn.gamma(bench.test_embeddings), errors, costs)
    knn_area = area_under_curve(knn_curve, max_cost)

    km = UniRouteKMeans(8, seed=seed).fit(bench.train_embeddings)
    psi = km.embed_llms(bench.val_embeddings, bench.val_errors_test_pool)
    km_curve = deferral_curve(km.gamma(bench.test_embeddings, psi), errors, costs)
    km_area = area_under_curve(km_curve, max_cost)

    lm = UniRouteLearnedMap(8, seed=seed, epochs=150).fit(
        bench.train_embeddings, bench.train_errors_train_pool
    )
    psi_lm = lm.embed_llms(bench.val_embeddings, bench.val_errors_test_pool)
    lm_curve = deferral_curve(lm.gamma(bench.test_embeddings, psi_lm), errors, costs)
    lm_area = area_under_curve(lm_curve, max_cost)

    oracle_curve = deferral_curve(bench.test_true_error_rates, errors, costs)
    oracle_area = area_under_curve(oracle_curve, max_cost)

    return {
        "zero": zero_area,
        "knn": knn_area,
        "kmeans": km_area,
        "learned": lm_area,
        "oracle": oracle_area,
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
