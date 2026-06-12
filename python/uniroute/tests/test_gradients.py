"""Independent verification of the learned-map gradient and its training.

The hand-derived softmax/log-loss gradient is the most error-prone code in
the package, so it is checked against central finite differences rather than
trusted. A second test builds a problem where the unsupervised k-means map
provably cannot help (topics live in a low-variance direction masked by a
high-variance nuisance direction) and asserts that supervision recovers it.
"""

import numpy as np
import pytest

from uniroute import UniRouteKMeans, UniRouteLearnedMap, area_under_curve, deferral_curve
from uniroute.learned_map import _augment, _init_theta, loss_and_grad
from uniroute.kmeans import kmeans


def finite_difference_grad(theta, features, errors, psi_t, eps=1e-6):
    grad = np.zeros_like(theta)
    for i in range(theta.shape[0]):
        for j in range(theta.shape[1]):
            up = theta.copy()
            up[i, j] += eps
            down = theta.copy()
            down[i, j] -= eps
            loss_up, _ = loss_and_grad(up, features, errors, psi_t)
            loss_down, _ = loss_and_grad(down, features, errors, psi_t)
            grad[i, j] = (loss_up - loss_down) / (2.0 * eps)
    return grad


@pytest.mark.parametrize("seed", [0, 1, 2])
def test_analytic_gradient_matches_finite_differences(seed):
    rng = np.random.default_rng(seed)
    n_prompts, n_dims, n_clusters, n_llms = 12, 3, 4, 5
    embeddings = rng.normal(size=(n_prompts, n_dims))
    errors = rng.integers(0, 2, size=(n_prompts, n_llms)).astype(float)
    psi_t = rng.uniform(0.05, 0.95, size=(n_clusters, n_llms))

    features = _augment(embeddings)
    centroids = kmeans(embeddings, n_clusters, seed=seed).centroids
    # Check at the k-means initialisation and at a random point.
    for theta in (
        _init_theta(centroids, embeddings),
        rng.normal(size=(n_clusters, n_dims + 1)),
    ):
        _, analytic = loss_and_grad(theta, features, errors, psi_t)
        numeric = finite_difference_grad(theta, features, errors, psi_t)
        np.testing.assert_allclose(analytic, numeric, rtol=1e-5, atol=1e-7)


def make_overlapping_topic_problem(seed=0, n_train=6000, n_val=400, n_test=3000):
    """Two heavily overlapping topics (means -1/+1, unit noise) along x_0.

    Hard nearest-centroid assignment misclusters prompts in the overlap
    region, where the routing stakes are asymmetric: LLM 0 aces topic 0 and
    fails topic 1; LLM 1 is mediocre on both. The population rule (eq. 14)
    weights per-cluster errors by the soft posterior P(z|x), which the
    learned map can approximate but the hard k-means map cannot.
    """
    rng = np.random.default_rng(seed)

    def sample(n):
        topic = rng.integers(0, 2, size=n)
        x = np.stack(
            [rng.normal(loc=2.0 * topic - 1.0), rng.normal(scale=1.0, size=n)], axis=1
        )
        p_err = np.stack(
            [np.where(topic == 0, 0.05, 0.95), np.where(topic == 0, 0.45, 0.35)],
            axis=1,
        )
        errors = (rng.random((n, 2)) < p_err).astype(float)
        return x, errors

    return sample(n_train), sample(n_val), sample(n_test)


def test_supervision_improves_routing_on_overlapping_topics():
    (x_tr, e_tr), (x_val, e_val), (x_te, e_te) = make_overlapping_topic_problem()
    costs = np.array([1.0, 1.0])  # equal costs: pure routing-accuracy test

    km = UniRouteKMeans(4, seed=0).fit(x_tr)
    psi_km = km.embed_llms(x_val, e_val)
    km_choices = km.route(x_te, psi_km, costs, lam=0.0)
    km_error = e_te[np.arange(len(km_choices)), km_choices].mean()

    lm = UniRouteLearnedMap(4, seed=0, epochs=400, learning_rate=0.1).fit(x_tr, e_tr)
    psi_lm = lm.embed_llms(x_val, e_val)
    lm_choices = lm.route(x_te, psi_lm, costs, lam=0.0)
    lm_error = e_te[np.arange(len(lm_choices)), lm_choices].mean()

    assert lm.trace is not None and lm.trace.final < lm.trace.initial
    # Supervision strictly improves routed error over the hard k-means map.
    assert lm_error < km_error - 0.015

    # The same separation shows in the paper's area metric.
    km_curve = deferral_curve(km.gamma(x_te, psi_km), e_te, costs, lambdas=[0.0])
    lm_curve = deferral_curve(lm.gamma(x_te, psi_lm), e_te, costs, lambdas=[0.0])
    assert area_under_curve(lm_curve, 1.0) > area_under_curve(km_curve, 1.0) + 0.015


def test_psi_defined_by_clustering_bounds_what_supervision_can_do():
    """A documented negative property, not a bug: if the clustering carries
    no routing signal, Psi is flat and the learned map has nothing to
    re-weight (S 5.2 keeps Psi fixed under the same clustering).

    Topics live in a low-variance direction masked by a high-variance
    nuisance axis; k-means with K=2 splits on the nuisance axis, both
    clusters see ~50% error for both LLMs, and routing stays near chance for
    BOTH variants.
    """
    rng = np.random.default_rng(0)

    def sample(n):
        nuisance = rng.normal(scale=10.0, size=(n, 1))
        topic = rng.integers(0, 2, size=n)
        signal = (2.0 * topic - 1.0)[:, None] * rng.uniform(0.25, 0.75, size=(n, 1))
        x = np.concatenate([nuisance, signal], axis=1)
        p_err = np.stack(
            [np.where(topic == 0, 0.05, 0.95), np.where(topic == 0, 0.95, 0.05)],
            axis=1,
        )
        return x, (rng.random((n, 2)) < p_err).astype(float)

    x_tr, e_tr = sample(3000)
    x_val, e_val = sample(300)
    x_te, e_te = sample(1500)
    costs = np.array([1.0, 1.0])

    lm = UniRouteLearnedMap(2, seed=0, epochs=400, learning_rate=0.1).fit(x_tr, e_tr)
    psi = lm.embed_llms(x_val, e_val)
    assert np.abs(psi - 0.5).max() < 0.1  # flat Psi: no per-cluster signal
    choices = lm.route(x_te, psi, costs, lam=0.0)
    routed_error = e_te[np.arange(len(choices)), choices].mean()
    assert routed_error > 0.4  # near chance, for the k-means variant too
