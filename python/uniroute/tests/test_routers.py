import numpy as np
import pytest

from uniroute import (
    KNNRouter,
    UniRouteKMeans,
    ZeroRouter,
    cluster_error_embedding,
    route,
)


class TestRoute:
    def test_lambda_zero_picks_lowest_gamma(self):
        gamma = np.array([[0.9, 0.1, 0.5], [0.2, 0.8, 0.3]])
        costs = np.array([1.0, 100.0, 10.0])
        np.testing.assert_array_equal(route(gamma, costs, 0.0), [1, 0])

    def test_large_lambda_picks_cheapest(self):
        gamma = np.array([[0.9, 0.0], [0.9, 0.0]])
        costs = np.array([1.0, 100.0])
        np.testing.assert_array_equal(route(gamma, costs, 1e9), [0, 0])

    def test_ties_break_toward_cheaper(self):
        gamma = np.array([[0.5, 0.5]])
        costs = np.array([10.0, 1.0])
        np.testing.assert_array_equal(route(gamma, costs, 0.0), [1])

    def test_negative_lambda_rejected(self):
        with pytest.raises(ValueError):
            route(np.zeros((1, 2)), np.ones(2), -1.0)


class TestClusterErrorEmbedding:
    def test_per_cluster_means(self):
        # Cluster 0: prompts 0,1; cluster 1: prompt 2.
        ids = np.array([0, 0, 1])
        errors = np.array([[1.0, 0.0], [0.0, 0.0], [1.0, 1.0]])
        psi = cluster_error_embedding(ids, errors, 2)
        np.testing.assert_allclose(psi, [[0.5, 1.0], [0.0, 1.0]])

    def test_empty_cluster_falls_back_to_overall_error(self):
        ids = np.array([0, 0])
        errors = np.array([[1.0], [0.0]])
        psi = cluster_error_embedding(ids, errors, 3)
        np.testing.assert_allclose(psi, [[0.5, 0.5, 0.5]])


class TestUniRouteKMeans:
    def test_routes_each_cluster_to_its_specialist(self):
        rng = np.random.default_rng(0)
        left = rng.normal(loc=(-5, 0), scale=0.3, size=(60, 2))
        right = rng.normal(loc=(5, 0), scale=0.3, size=(60, 2))
        train = np.concatenate([left, right])

        # Validation: 10 prompts per side. LLM 0 is perfect on the left and
        # hopeless on the right; LLM 1 is the mirror image. Equal costs.
        val = np.concatenate([left[:10], right[:10]])
        val_errors = np.zeros((20, 2))
        val_errors[:10, 1] = 1.0  # LLM 1 wrong on the left
        val_errors[10:, 0] = 1.0  # LLM 0 wrong on the right

        router = UniRouteKMeans(2, seed=0).fit(train)
        psi = router.embed_llms(val, val_errors)
        test = np.array([[-5.0, 0.0], [5.0, 0.0]])
        choices = router.route(test, psi, np.array([1.0, 1.0]), lam=0.0)
        np.testing.assert_array_equal(choices, [0, 1])

    def test_unseen_llm_needs_only_its_validation_errors(self):
        # The router is fitted before the "new" LLM exists; embedding it is
        # a single embed_llms call with one extra error column.
        rng = np.random.default_rng(1)
        train = rng.normal(size=(100, 4))
        router = UniRouteKMeans(4, seed=0).fit(train)
        val = rng.normal(size=(40, 4))
        old = rng.integers(0, 2, size=(40, 1)).astype(float)
        new = np.zeros((40, 1))  # the new LLM is perfect everywhere
        psi = router.embed_llms(val, np.concatenate([old, new], axis=1))
        choices = router.route(val, psi, np.array([1.0, 1.0]), lam=0.0)
        assert (choices == 1).all()

    def test_gamma_matches_cluster_means(self):
        train = np.array([[0.0], [0.1], [10.0], [10.1]])
        router = UniRouteKMeans(2, seed=0).fit(train)
        val = np.array([[0.0], [10.0]])
        val_errors = np.array([[0.25], [0.75]])
        psi = router.embed_llms(val, val_errors)
        gamma = router.gamma(np.array([[0.05], [9.9]]), psi)
        np.testing.assert_allclose(sorted(gamma[:, 0].tolist()), [0.25, 0.75])

    def test_unfitted_raises(self):
        with pytest.raises(RuntimeError):
            UniRouteKMeans(2).cluster_ids(np.zeros((1, 2)))


class TestKNNRouter:
    def test_gamma_is_mean_over_neighbors(self):
        val = np.array([[0.0], [1.0], [10.0]])
        errors = np.array([[1.0], [0.0], [0.0]])
        router = KNNRouter(n_neighbors=2).fit(val, errors)
        gamma = router.gamma(np.array([[0.4]]))
        np.testing.assert_allclose(gamma, [[0.5]])  # neighbours: 0.0 and 1.0

    def test_too_many_neighbors_rejected(self):
        with pytest.raises(ValueError):
            KNNRouter(n_neighbors=5).fit(np.zeros((3, 1)), np.zeros((3, 1)))


class TestZeroRouter:
    def test_dominated_model_is_off_the_frontier(self):
        costs = np.array([1.0, 5.0, 10.0])
        # Model 1 costs more than model 0 but is worse: dominated.
        val_errors = np.array([[0.4, 0.6, 0.1], [0.4, 0.6, 0.1]])
        zero = ZeroRouter().fit(costs, val_errors)
        assert zero.frontier == [0, 2]

    def test_concavity_pops_under_chord_points(self):
        costs = np.array([1.0, 5.0, 10.0])
        # Model 1 is better than model 0 but lies below the 0 -> 2 chord.
        quality = np.array([0.5, 0.55, 0.95])
        val_errors = np.tile(1.0 - quality, (10, 1))
        zero = ZeroRouter().fit(costs, val_errors)
        assert zero.frontier == [0, 2]

    def test_plan_meets_budget_exactly(self):
        costs = np.array([1.0, 9.0])
        val_errors = np.array([[0.5, 0.0]] * 10)
        zero = ZeroRouter().fit(costs, val_errors)
        plan = zero.plan(5.0)
        assert plan.low_index == 0 and plan.high_index == 1
        assert plan.expected(costs) == pytest.approx(5.0)

    def test_budget_below_cheapest_rejected(self):
        zero = ZeroRouter().fit(np.array([2.0, 4.0]), np.zeros((5, 2)))
        with pytest.raises(ValueError):
            zero.plan(1.0)

    def test_sample_respects_weights(self):
        costs = np.array([1.0, 9.0])
        val_errors = np.array([[0.5, 0.0]] * 10)
        zero = ZeroRouter().fit(costs, val_errors)
        draws = zero.sample(5.0, 20000, seed=0)
        assert (draws == 1).mean() == pytest.approx(0.5, abs=0.02)
