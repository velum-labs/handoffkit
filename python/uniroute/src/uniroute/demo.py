"""Runnable demonstration of UniRoute on the synthetic benchmark.

    python -m uniroute.demo [--trials N] [--seed S]

Reproduces the shape of the paper's Figure 2 table on synthetic data:
ZeroRouter, K-NN, UniRoute (K-means), UniRoute (LearnedMap), and a
clairvoyant oracle that routes on the true per-prompt error probabilities
(the upper bound of eq. 8). Every method routes over *unseen* test-pool
LLMs represented only by their validation error vectors.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass

import numpy as np

from .evaluate import (
    area_under_curve,
    deferral_curve,
    quality_neutral_cost,
    select_n_clusters,
    zero_router_curve,
)
from .learned_map import UniRouteLearnedMap
from .routers import KNNRouter, UniRouteKMeans, ZeroRouter
from .synthetic import make_benchmark


@dataclass
class MethodResult:
    area_50: list[float]
    area_100: list[float]
    qnc: list[float]

    def __init__(self) -> None:
        self.area_50 = []
        self.area_100 = []
        self.qnc = []

    def add(self, area_50: float, area_100: float, qnc: float) -> None:
        self.area_50.append(area_50)
        self.area_100.append(area_100)
        self.qnc.append(qnc)


def _summary(values: list[float]) -> str:
    finite = [v for v in values if np.isfinite(v)]
    if not finite:
        return ">100%".rjust(13)
    mean = float(np.mean(finite))
    std = float(np.std(finite))
    return f"{mean:.3f}±{std:.3f}"


def _qnc_summary(values: list[float]) -> str:
    shown = [min(v, 1.0) if np.isfinite(v) else 1.0 for v in values]
    mean = 100.0 * float(np.mean(shown))
    return f"{mean:5.1f}%"


def run_trial(seed: int, n_clusters_grid: list[int], results: dict[str, MethodResult]) -> int:
    bench = make_benchmark(seed=seed)
    costs = bench.test_pool_costs
    max_cost = float(costs.max())
    test_errors = bench.test_errors_test_pool

    def score(name: str, curve) -> None:
        results[name].add(
            area_under_curve(curve, max_cost, up_to=0.5),
            area_under_curve(curve, max_cost, up_to=1.0),
            quality_neutral_cost(curve, test_errors, costs),
        )

    # Hyper-parameter K via the Appendix F.1 procedure (training pool only).
    chosen_k = select_n_clusters(
        n_clusters_grid,
        bench.train_embeddings,
        bench.train_errors_train_pool,
        bench.val_embeddings,
        bench.val_errors_train_pool,
        bench.train_pool_costs,
        seed=seed,
    )

    # ZeroRouter (Appendix D): prompt-independent mixture on the frontier.
    zero = ZeroRouter().fit(costs, bench.val_errors_test_pool)
    score("ZeroRouter", zero_router_curve(zero, test_errors, costs))

    # K-NN router (eq. 5) over the validation set.
    knn = KNNRouter(n_neighbors=min(10, bench.val_embeddings.shape[0])).fit(
        bench.val_embeddings, bench.val_errors_test_pool
    )
    score("K-NN", deferral_curve(knn.gamma(bench.test_embeddings), test_errors, costs))

    # UniRoute (K-means), S 5.1: unsupervised map, unseen LLMs via Psi.
    km = UniRouteKMeans(chosen_k, seed=seed).fit(bench.train_embeddings)
    psi_km = km.embed_llms(bench.val_embeddings, bench.val_errors_test_pool)
    score(
        "UniRoute (K-means)",
        deferral_curve(km.gamma(bench.test_embeddings, psi_km), test_errors, costs),
    )

    # UniRoute (LearnedMap), S 5.2: supervised map trained on the TRAINING
    # pool's labels; the test pool still enters only through Psi.
    lm = UniRouteLearnedMap(chosen_k, seed=seed).fit(
        bench.train_embeddings, bench.train_errors_train_pool
    )
    psi_lm = lm.embed_llms(bench.val_embeddings, bench.val_errors_test_pool)
    score(
        "UniRoute (LearnedMap)",
        deferral_curve(lm.gamma(bench.test_embeddings, psi_lm), test_errors, costs),
    )

    # Clairvoyant oracle: routes on the true per-prompt error probabilities.
    score(
        "Oracle (clairvoyant)",
        deferral_curve(bench.test_true_error_rates, test_errors, costs),
    )
    return chosen_k


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--trials", type=int, default=5, help="independent trials")
    parser.add_argument("--seed", type=int, default=0, help="base seed")
    args = parser.parse_args(argv)

    methods = [
        "ZeroRouter",
        "K-NN",
        "UniRoute (K-means)",
        "UniRoute (LearnedMap)",
        "Oracle (clairvoyant)",
    ]
    results = {name: MethodResult() for name in methods}
    grid = [4, 8, 16, 32]

    print("UniRoute on a synthetic dynamic-pool benchmark (arXiv:2502.08773)")
    print(f"trials={args.trials}, K grid={grid}, unseen test LLMs only\n")
    chosen: list[int] = []
    for t in range(args.trials):
        chosen.append(run_trial(args.seed + t, grid, results))
    print(f"selected K per trial (Appendix F.1 procedure): {chosen}\n")

    header = f"{'method':<24} {'Area(50%) ↑':>16} {'Area ↑':>16} {'QNC ↓':>8}"
    print(header)
    print("-" * len(header))
    for name in methods:
        r = results[name]
        print(
            f"{name:<24} {_summary(r.area_50):>16} {_summary(r.area_100):>16}"
            f" {_qnc_summary(r.qnc):>8}"
        )
    print(
        "\nArea: mean quality over a uniformly random budget (cost normalised by"
        "\nthe priciest LLM); QNC: min relative cost to match the most accurate"
        "\nLLM (capped at 100% when never matched)."
    )


if __name__ == "__main__":
    main()
