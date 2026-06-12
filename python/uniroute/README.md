# UniRoute (Python)

A NumPy implementation of **"Universal Model Routing for Efficient LLM Inference"**
(Jitkrittum et al., [arXiv:2502.08773v2](https://arxiv.org/abs/2502.08773)).

Model routing sends each prompt to the cheapest LLM that can handle it. Existing
routers are trained for a *fixed* pool of LLMs; UniRoute handles a **dynamic pool** —
models added after training — by representing every LLM as a feature vector of its
prediction errors on a small validation set. A new LLM only needs one pass over that
validation set; the router itself is never retrained.

## What is implemented

| Paper reference | This package |
| --- | --- |
| Plug-in routing rule `argmin_m [γ(x,h_m) + λ·c(h_m)]` (eq. 9) | `route` |
| Per-cluster error LLM embedding `Ψ_clust(h)` (eq. 13) | `cluster_error_embedding`, `*.embed_llms` |
| UniRoute with unsupervised K-means map (§5.1, eq. 12) | `UniRouteKMeans` |
| UniRoute with learned softmax cluster map (§5.2) | `UniRouteLearnedMap` |
| K-NN router baseline (eq. 5; special case of UniRoute, §4.2) | `KNNRouter` |
| ZeroRouter baseline (Appendix D) | `ZeroRouter`, `zero_router_curve` |
| Deferral curves, Area / Area(50%), QNC (§7, Appendix E.2) | `deferral_curve`, `area_under_curve`, `quality_neutral_cost` |
| K selection on the training pool (Appendix F.1) | `select_n_clusters` |
| Synthetic benchmark with the paper's 60/10/30 prompt and 2/3–1/3 LLM splits (§7.1) | `make_benchmark` |

Seeded k-means++ (`kmeans`) and the full-batch Adam fit of the learned map are
included, so the only dependency is NumPy.

## Quickstart

This package is a member of the repository's [uv](https://docs.astral.sh/uv/)
workspace (rooted at the repo-level `pyproject.toml`, sharing one `uv.lock`).
From the repository root:

```sh
uv sync --all-packages        # one .venv for the whole Python workspace
uv run uniroute-demo          # Figure-2-style table on synthetic data
uv run pytest python/uniroute/tests
```

Or from this directory: `uv run pytest` / `uv run python -m uniroute.demo`.
The package also installs with plain pip (`pip install -e .`) if you prefer.

The demo routes over LLMs that the router never saw during training and prints, per
method, the area under the deferral curve (up to 50% and 100% of the maximum cost)
and the quality-neutral cost (QNC) — the minimum relative cost at which the router
matches the most accurate LLM in the pool.

## Using it on your own data

Everything is plain arrays: prompt embeddings of shape `(n_prompts, n_dims)` (any
text embedder works; the paper uses Gecko), a 0-1 loss matrix of shape
`(n_prompts, n_llms)` (1 = the LLM got the prompt wrong), and per-prompt costs of
shape `(n_llms,)` (API price, parameter count, latency, …).

```python
import numpy as np
from uniroute import UniRouteKMeans

# 1. Train once, with no LLM labels at all (unsupervised variant).
router = UniRouteKMeans(n_clusters=16, seed=0).fit(train_embeddings)

# 2. Any time a new LLM appears: evaluate it once on a small labelled
#    validation set and embed it. No retraining.
psi = router.embed_llms(val_embeddings, val_errors)   # (n_llms, K)

# 3. Route. lam trades quality against cost: 0 = best model wins,
#    large = cheapest model wins.
choices = router.route(test_embeddings, psi, costs, lam=0.01)
```

The supervised variant additionally consumes the training pool's correctness
labels to learn a better prompt-to-cluster map (the test pool still enters only
through `psi`):

```python
from uniroute import UniRouteLearnedMap

router = UniRouteLearnedMap(n_clusters=16, seed=0).fit(
    train_embeddings, train_errors_of_training_pool
)
psi = router.embed_llms(val_embeddings, val_errors)
choices = router.route(test_embeddings, psi, costs, lam=0.01)
```

To compare methods, sweep λ into a deferral curve and reduce it to the paper's
metrics:

```python
from uniroute import area_under_curve, deferral_curve, quality_neutral_cost

curve = deferral_curve(router.gamma(test_embeddings, psi), test_errors, costs)
area = area_under_curve(curve, max_cost=float(costs.max()))
qnc = quality_neutral_cost(curve, test_errors, costs)
```

## Conventions and small deviations

- **0-1 loss only.** The paper's general-loss extension (eq. 7) reduces to plugging
  a different loss matrix into the same code paths; the implementation keeps the 0-1
  convention of §3.2 (`errors` entries in `[0, 1]`, 1 = wrong).
- **Area normalisation.** The deferral curve extends flat on both ends of the cost
  axis (normalised by the priciest LLM), so the area reads as expected quality under
  a uniformly random budget. The paper does not pin down its convention; this one
  applies identically to all methods.
- **Learned-map Ψ source.** §5.2 estimates the training pool's `Ψ_clust` from the
  validation set; `UniRouteLearnedMap.fit` defaults to the training set (strictly
  more labels) and accepts `psi_embeddings`/`psi_errors` to reproduce the paper's
  choice exactly.
- **Learned-map initialisation.** θ starts at a softened version of the k-means
  assignment (a soft-min of squared distances, realised with a bias feature), so
  gradient descent starts from the §5.1 router rather than from noise.
