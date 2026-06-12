"""One synthetic-benchmark trial, shared by the demo and the e2e tests.

Fits every router family the paper compares — ZeroRouter (Appendix D), the
k-NN router (eq. 5), UniRoute with the unsupervised k-means map (S 5.1),
UniRoute with the supervised learned map (S 5.2), and the clairvoyant
oracle — and returns their deferral curves. Callers score the curves with
whatever metrics they need; the fitting protocol (which split sees which
labels) lives in exactly one place.
"""

from __future__ import annotations

from .evaluate import DeferralCurve, deferral_curve, zero_router_curve
from .learned_map import UniRouteLearnedMap
from .routers import KNNRouter, UniRouteKMeans, ZeroRouter
from .synthetic import SyntheticBenchmark


def synthetic_trial_curves(
    bench: SyntheticBenchmark,
    n_clusters: int,
    seed: int,
    *,
    epochs: int | None = None,
    n_neighbors: int = 10,
) -> dict[str, DeferralCurve]:
    """Deferral curves per router, keyed by the paper's method names.

    All routing over the TEST LLM pool uses only (i) unlabelled training
    prompts and (ii) the small labelled validation set — never the test
    pool's test-set labels.
    """
    costs = bench.test_pool_costs
    errors = bench.test_errors_test_pool

    zero = ZeroRouter().fit(costs, bench.val_errors_test_pool)

    knn = KNNRouter(n_neighbors=min(n_neighbors, bench.val_embeddings.shape[0])).fit(
        bench.val_embeddings, bench.val_errors_test_pool
    )

    km = UniRouteKMeans(n_clusters, seed=seed).fit(bench.train_embeddings)
    psi_km = km.embed_llms(bench.val_embeddings, bench.val_errors_test_pool)

    lm_kwargs = {} if epochs is None else {"epochs": epochs}
    lm = UniRouteLearnedMap(n_clusters, seed=seed, **lm_kwargs).fit(
        bench.train_embeddings, bench.train_errors_train_pool
    )
    psi_lm = lm.embed_llms(bench.val_embeddings, bench.val_errors_test_pool)

    return {
        "ZeroRouter": zero_router_curve(zero, errors, costs),
        "K-NN": deferral_curve(knn.gamma(bench.test_embeddings), errors, costs),
        "UniRoute (K-means)": deferral_curve(
            km.gamma(bench.test_embeddings, psi_km), errors, costs
        ),
        "UniRoute (LearnedMap)": deferral_curve(
            lm.gamma(bench.test_embeddings, psi_lm), errors, costs
        ),
        "Oracle (clairvoyant)": deferral_curve(bench.test_true_error_rates, errors, costs),
    }
