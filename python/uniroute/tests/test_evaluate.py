import numpy as np
import pytest
from uniroute import (
    DeferralCurve,
    ZeroRouter,
    area_under_curve,
    default_lambda_grid,
    deferral_curve,
    pareto_clean,
    quality_neutral_cost,
    zero_router_curve,
)


class TestParetoClean:
    def test_drops_dominated_points(self):
        costs = np.array([1.0, 2.0, 3.0, 4.0])
        quality = np.array([0.5, 0.4, 0.7, 0.7])
        curve = pareto_clean(costs, quality)
        np.testing.assert_allclose(curve.costs, [1.0, 3.0])
        np.testing.assert_allclose(curve.qualities, [0.5, 0.7])

    def test_sorts_by_cost(self):
        curve = pareto_clean(np.array([3.0, 1.0]), np.array([0.9, 0.2]))
        np.testing.assert_allclose(curve.costs, [1.0, 3.0])


class TestDeferralCurve:
    def test_endpoints_cover_both_extremes(self):
        # Two LLMs: cheap-and-weak vs expensive-and-strong, gamma is exact.
        gamma = np.array([[0.5, 0.0]] * 100)
        errors = np.array([[0.5, 0.0]] * 100)
        costs = np.array([1.0, 10.0])
        curve = deferral_curve(gamma, errors, costs)
        assert curve.costs[0] == pytest.approx(1.0)  # lambda -> inf: cheapest
        assert curve.costs[-1] == pytest.approx(10.0)  # lambda = 0: best
        assert curve.qualities[-1] == pytest.approx(1.0)

    def test_curve_is_monotone(self):
        rng = np.random.default_rng(0)
        gamma = rng.random((200, 4))
        errors = rng.integers(0, 2, size=(200, 4)).astype(float)
        costs = np.array([1.0, 3.0, 7.0, 20.0])
        curve = deferral_curve(gamma, errors, costs)
        assert (np.diff(curve.costs) > 0).all()
        assert (np.diff(curve.qualities) > 0).all()

    def test_lambda_grid_handles_equal_costs(self):
        np.testing.assert_array_equal(default_lambda_grid(np.array([2.0, 2.0])), [0.0])


class TestArea:
    def test_constant_quality_curve(self):
        curve = DeferralCurve(costs=np.array([2.0]), qualities=np.array([0.8]))
        assert area_under_curve(curve, max_cost=10.0) == pytest.approx(0.8)
        assert area_under_curve(curve, max_cost=10.0, up_to=0.5) == pytest.approx(0.8)

    def test_linear_segment_integrates_exactly(self):
        # Quality rises linearly 0.4 -> 0.8 over normalised cost 0 -> 1.
        curve = DeferralCurve(
            costs=np.array([0.0, 10.0]), qualities=np.array([0.4, 0.8])
        )
        assert area_under_curve(curve, max_cost=10.0) == pytest.approx(0.6)
        # Up to 50%: mean of 0.4 and 0.6.
        assert area_under_curve(curve, max_cost=10.0, up_to=0.5) == pytest.approx(0.5)

    def test_invalid_arguments(self):
        curve = DeferralCurve(costs=np.array([1.0]), qualities=np.array([0.5]))
        with pytest.raises(ValueError):
            area_under_curve(curve, max_cost=0.0)
        with pytest.raises(ValueError):
            area_under_curve(curve, max_cost=1.0, up_to=0.0)


class TestQualityNeutralCost:
    def test_interpolates_first_crossing(self):
        # Best LLM: quality 0.7 at cost 8. The curve crosses 0.7 at cost 5.
        curve = DeferralCurve(
            costs=np.array([2.0, 6.0]), qualities=np.array([0.4, 0.8])
        )
        errors = np.tile([0.5, 0.3], (10, 1))
        costs = np.array([1.0, 8.0])
        qnc = quality_neutral_cost(curve, errors, costs)
        assert qnc == pytest.approx(5.0 / 8.0)

    def test_unreachable_quality_is_inf(self):
        curve = DeferralCurve(costs=np.array([1.0]), qualities=np.array([0.2]))
        errors = np.tile([0.5, 0.1], (10, 1))
        costs = np.array([1.0, 8.0])
        assert quality_neutral_cost(curve, errors, costs) == float("inf")


class TestZeroRouterCurve:
    def test_expected_quality_interpolates_frontier(self):
        costs = np.array([1.0, 9.0])
        val_errors = np.tile([0.5, 0.1], (50, 1))
        test_errors = np.tile([0.6, 0.2], (50, 1))
        zero = ZeroRouter().fit(costs, val_errors)
        curve = zero_router_curve(zero, test_errors, costs, n_budgets=5)
        assert curve.costs[0] == pytest.approx(1.0)
        assert curve.costs[-1] == pytest.approx(9.0)
        assert curve.qualities[0] == pytest.approx(0.4)
        assert curve.qualities[-1] == pytest.approx(0.8)
        # Midpoint budget: equal mixture.
        assert curve.quality_at(5.0) == pytest.approx(0.6)
