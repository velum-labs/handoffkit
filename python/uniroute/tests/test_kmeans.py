import numpy as np
import pytest
from uniroute import assign, kmeans


def make_blobs(seed: int = 0):
    rng = np.random.default_rng(seed)
    centres = np.array([[-10.0, 0.0], [10.0, 0.0], [0.0, 10.0]])
    points = np.concatenate(
        [centre + rng.normal(scale=0.5, size=(50, 2)) for centre in centres]
    )
    labels = np.repeat(np.arange(3), 50)
    return points, labels, centres


def test_recovers_separated_clusters():
    points, true_labels, centres = make_blobs()
    result = kmeans(points, 3, seed=0)
    # Each fitted centroid should sit on one distinct true centre.
    matched = {int(np.linalg.norm(centres - c, axis=1).argmin()) for c in result.centroids}
    assert matched == {0, 1, 2}
    # Cluster memberships agree with the generating partition.
    for k in range(3):
        members = result.labels[true_labels == k]
        assert len(set(members.tolist())) == 1


def test_deterministic_for_a_seed():
    points, _, _ = make_blobs()
    a = kmeans(points, 3, seed=7)
    b = kmeans(points, 3, seed=7)
    np.testing.assert_array_equal(a.labels, b.labels)
    np.testing.assert_allclose(a.centroids, b.centroids)


def test_k_equals_one_is_the_mean():
    points, _, _ = make_blobs()
    result = kmeans(points, 1, seed=0)
    np.testing.assert_allclose(result.centroids[0], points.mean(axis=0))


def test_assign_matches_fit_labels():
    points, _, _ = make_blobs()
    result = kmeans(points, 3, seed=0)
    np.testing.assert_array_equal(assign(points, result.centroids), result.labels)


def test_more_clusters_than_points_rejected():
    with pytest.raises(ValueError):
        kmeans(np.zeros((3, 2)), 4)


def test_duplicate_points_do_not_crash():
    points = np.zeros((10, 2))
    result = kmeans(points, 3, seed=0)
    assert result.centroids.shape == (3, 2)
    assert result.inertia == 0.0
