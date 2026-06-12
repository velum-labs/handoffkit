import numpy as np
import pytest
from uniroute import UniRouteKMeans, UniRouteLearnedMap

from uniroute_mlx import build_card, load_card, save_card


def fitted_kmeans_router(seed=0):
    rng = np.random.default_rng(seed)
    left = rng.normal(loc=(-5.0, 0.0), scale=0.3, size=(50, 2))
    right = rng.normal(loc=(5.0, 0.0), scale=0.3, size=(50, 2))
    train = np.concatenate([left, right])
    return UniRouteKMeans(2, seed=seed).fit(train), train


def test_kmeans_card_roundtrip_and_decisions(tmp_path):
    router, _ = fitted_kmeans_router()
    # Identify which centroid is the "left" cluster so psi rows mean something.
    left_cluster = int(router.cluster_ids(np.array([[-5.0, 0.0]]))[0])
    # Model A is perfect on the left cluster, bad on the right; B mirrors.
    psi = np.zeros((2, 2))
    psi[0, left_cluster] = 0.05
    psi[0, 1 - left_cluster] = 0.9
    psi[1, left_cluster] = 0.9
    psi[1, 1 - left_cluster] = 0.05
    costs = np.array([1.0, 1.0])

    card = build_card(router, psi, costs, ["model-a", "model-b"], embedder_model="emb")
    path = tmp_path / "card.json"
    save_card(card, path)
    loaded = load_card(path)

    assert loaded.assignment_type == "centroids"
    assert loaded.embedder_model == "emb"
    np.testing.assert_allclose(loaded.assignment, router.centroids)

    left_decision = loaded.decide(np.array([-5.0, 0.0]))
    right_decision = loaded.decide(np.array([5.0, 0.0]))
    assert left_decision.model_id == "model-a"
    assert right_decision.model_id == "model-b"
    assert left_decision.predicted_error == pytest.approx(0.05)

    # The card's decision matches the source router's plug-in rule exactly.
    expected = router.route(np.array([[-5.0, 0.0]]), psi, costs, lam=0.0)[0]
    assert left_decision.model_id == ["model-a", "model-b"][int(expected)]


def test_lambda_shifts_choice_to_cheaper_model(tmp_path):
    router, _ = fitted_kmeans_router()
    psi = np.array([[0.3, 0.3], [0.1, 0.1]])  # model B better everywhere...
    costs = np.array([1.0, 50.0])  # ...but far more expensive
    card = build_card(
        router, psi, costs, ["cheap", "pricey"], embedder_model="emb", default_lambda=0.0
    )
    embedding = np.array([-5.0, 0.0])
    assert card.decide(embedding).model_id == "pricey"  # card default lam=0
    assert card.decide(embedding, lam=0.01).model_id == "cheap"


def test_learned_map_card_uses_softmax_assignment(tmp_path):
    rng = np.random.default_rng(0)
    train = np.concatenate(
        [
            rng.normal(loc=(-5.0, 0.0), scale=0.3, size=(50, 2)),
            rng.normal(loc=(5.0, 0.0), scale=0.3, size=(50, 2)),
        ]
    )
    errors = np.zeros((100, 2))
    errors[:50, 1] = 1.0
    errors[50:, 0] = 1.0
    router = UniRouteLearnedMap(2, seed=0, epochs=50).fit(train, errors)

    left_weights = router.assignment(np.array([[-5.0, 0.0]]))[0]
    left_cluster = int(left_weights.argmax())
    psi = np.zeros((2, 2))
    psi[0, left_cluster] = 0.05
    psi[0, 1 - left_cluster] = 0.9
    psi[1, left_cluster] = 0.9
    psi[1, 1 - left_cluster] = 0.05

    card = build_card(router, psi, np.ones(2), ["a", "b"], embedder_model="emb")
    path = tmp_path / "card.json"
    save_card(card, path)
    loaded = load_card(path)

    assert loaded.assignment_type == "softmax"
    # Loaded card reproduces the router's soft assignment exactly.
    np.testing.assert_allclose(
        loaded.cluster_weights(np.array([-5.0, 0.0])), left_weights, atol=1e-12
    )
    assert loaded.decide(np.array([-5.0, 0.0])).model_id == "a"
    assert loaded.decide(np.array([5.0, 0.0])).model_id == "b"


def test_card_validation_rejects_corruption(tmp_path):
    router, _ = fitted_kmeans_router()
    card = build_card(
        router, np.zeros((1, 2)), np.ones(1), ["only"], embedder_model="emb"
    )
    path = tmp_path / "card.json"
    save_card(card, path)

    good = path.read_text(encoding="utf-8")
    path.write_text(good.replace("uniroute.router.v1", "uniroute.router.v0"), encoding="utf-8")
    with pytest.raises(ValueError, match="expected version"):
        load_card(path)

    path.write_text(good.replace('"dims": 2', '"dims": 7'), encoding="utf-8")
    with pytest.raises(ValueError, match="dims"):
        load_card(path)


def test_misaligned_inputs_rejected():
    router, _ = fitted_kmeans_router()
    with pytest.raises(ValueError, match="must align"):
        build_card(router, np.zeros((2, 2)), np.ones(3), ["a", "b"], embedder_model="e")
    with pytest.raises(ValueError, match="cluster count"):
        build_card(router, np.zeros((2, 5)), np.ones(2), ["a", "b"], embedder_model="e")
    card = build_card(router, np.zeros((2, 2)), np.ones(2), ["a", "b"], embedder_model="e")
    with pytest.raises(ValueError, match="shape"):
        card.decide(np.zeros(9))
