import numpy as np
from uniroute import UniRouteKMeans, UniRouteLearnedMap, make_benchmark


def test_assignment_rows_are_distributions():
    bench = make_benchmark(n_prompts=600, seed=0)
    router = UniRouteLearnedMap(4, seed=0, epochs=50).fit(
        bench.train_embeddings, bench.train_errors_train_pool
    )
    phi = router.assignment(bench.test_embeddings)
    np.testing.assert_allclose(phi.sum(axis=1), 1.0, atol=1e-9)
    assert (phi >= 0).all()


def test_training_reduces_log_loss():
    bench = make_benchmark(n_prompts=1500, seed=1)
    router = UniRouteLearnedMap(8, seed=1, epochs=200).fit(
        bench.train_embeddings, bench.train_errors_train_pool
    )
    assert router.trace is not None
    assert router.trace.final < router.trace.initial


def test_initialisation_matches_kmeans_router():
    # With zero training epochs the learned map is the softened k-means map,
    # so hard decisions should overwhelmingly agree with UniRouteKMeans.
    bench = make_benchmark(n_prompts=1200, seed=2)
    km = UniRouteKMeans(6, seed=2).fit(bench.train_embeddings)
    lm = UniRouteLearnedMap(6, seed=2, epochs=0).fit(
        bench.train_embeddings, bench.train_errors_train_pool
    )
    hard_km = km.assignment(bench.test_embeddings).argmax(axis=1)
    hard_lm = lm.assignment(bench.test_embeddings).argmax(axis=1)
    assert (hard_km == hard_lm).mean() > 0.95


def test_new_llm_embedding_is_identical_to_kmeans_variant():
    # Psi is defined by the clustering, not by theta (S 5.2), so both
    # variants must embed an unseen LLM identically.
    bench = make_benchmark(n_prompts=900, seed=3)
    km = UniRouteKMeans(5, seed=3).fit(bench.train_embeddings)
    lm = UniRouteLearnedMap(5, seed=3, epochs=10).fit(
        bench.train_embeddings, bench.train_errors_train_pool
    )
    psi_km = km.embed_llms(bench.val_embeddings, bench.val_errors_test_pool)
    psi_lm = lm.embed_llms(bench.val_embeddings, bench.val_errors_test_pool)
    np.testing.assert_allclose(psi_km, psi_lm)


def test_explicit_psi_source_is_supported():
    bench = make_benchmark(n_prompts=900, seed=4)
    router = UniRouteLearnedMap(4, seed=4, epochs=20).fit(
        bench.train_embeddings,
        bench.train_errors_train_pool,
        psi_embeddings=bench.val_embeddings,
        psi_errors=bench.val_errors_train_pool,
    )
    assert router.trace is not None and len(router.trace.losses) == 20
