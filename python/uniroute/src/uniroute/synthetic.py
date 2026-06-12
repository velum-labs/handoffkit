"""A synthetic routing benchmark mirroring the paper's experimental setup.

Real benchmarks (EmbedLLM, RouterBench, SPROUT) are tables of per-prompt 0-1
correctness for a pool of LLMs plus prompt embeddings. This module generates
the same shape of data with known ground truth, so the package is runnable
and testable offline:

- prompts are drawn from ``n_topics`` Gaussian topic clusters in embedding
  space (standing in for Gecko-style text embeddings);
- each LLM has a base skill plus a per-topic specialisation, and a per-prompt
  cost that grows with overall skill (better models cost more, as with
  parameter counts or API prices);
- 0-1 losses are Bernoulli draws from the LLM's error rate on the prompt's
  topic.

Following S 7.1: prompts split 60/10/30 into train/validation/test, and the
LLM pool splits into disjoint training and test pools, so test-time routing
is always over LLMs never seen during router training.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class SyntheticBenchmark:
    """One trial of the dynamic-pool routing problem."""

    # Prompt splits (embeddings).
    train_embeddings: np.ndarray
    val_embeddings: np.ndarray
    test_embeddings: np.ndarray
    # 0-1 losses for the TRAINING LLM pool (available at router-training
    # time; the validation rows feed the Appendix F.1 K-selection procedure).
    train_errors_train_pool: np.ndarray
    val_errors_train_pool: np.ndarray
    # 0-1 losses for the TEST LLM pool (validation set: allowed for Psi;
    # test set: ground truth for scoring only).
    val_errors_test_pool: np.ndarray
    test_errors_test_pool: np.ndarray
    # Costs per LLM.
    train_pool_costs: np.ndarray
    test_pool_costs: np.ndarray
    # Ground truth for analysis: per-prompt true error probability of each
    # test-pool LLM on the test prompts (the Bayes gamma* of eq. 8).
    test_true_error_rates: np.ndarray
    # Names, for narration.
    train_pool_names: list[str]
    test_pool_names: list[str]


def make_benchmark(
    *,
    n_prompts: int = 4000,
    n_dims: int = 32,
    n_topics: int = 8,
    n_llms: int = 15,
    seed: int = 0,
    topic_spread: float = 4.0,
    specialisation: float = 0.35,
) -> SyntheticBenchmark:
    """Generate one independent trial.

    Args:
        n_prompts: total prompts, split 60/10/30 train/val/test.
        n_dims: embedding dimensionality.
        n_topics: latent topic clusters (the mixture components of S 5.3).
        n_llms: pool size; 2/3 become training LLMs, 1/3 test LLMs.
        seed: drives every random draw in the trial.
        topic_spread: distance between topic centres relative to unit noise.
        specialisation: how strongly an LLM's accuracy varies across topics.
    """
    if n_llms < 3:
        raise ValueError("need at least 3 LLMs to form disjoint train/test pools")
    rng = np.random.default_rng(seed)

    centres = rng.normal(scale=topic_spread, size=(n_topics, n_dims))
    topics = rng.integers(n_topics, size=n_prompts)
    embeddings = centres[topics] + rng.normal(size=(n_prompts, n_dims))

    # LLM pool: base skill in [0.25, 0.95], per-topic specialisation around it.
    base_skill = rng.uniform(0.25, 0.95, size=n_llms)
    per_topic = np.clip(
        base_skill[:, None] + rng.uniform(-specialisation, specialisation, size=(n_llms, n_topics)),
        0.02,
        0.98,
    )
    # Cost grows superlinearly with skill, with jitter: a stand-in for
    # parameter count or API price. Costs are per prompt.
    costs = np.exp(3.0 * base_skill) * rng.uniform(0.8, 1.25, size=n_llms)

    error_probability = 1.0 - per_topic[:, topics].T  # (n_prompts, n_llms)
    errors = (rng.random((n_prompts, n_llms)) < error_probability).astype(np.float64)

    # 60/10/30 prompt split (S 7.1).
    order = rng.permutation(n_prompts)
    n_train = int(n_prompts * 0.6)
    n_val = int(n_prompts * 0.1)
    train_idx = order[:n_train]
    val_idx = order[n_train : n_train + n_val]
    test_idx = order[n_train + n_val :]

    # Disjoint LLM pools: 2/3 train, 1/3 test (S 7.1, EmbedLLM protocol).
    llm_order = rng.permutation(n_llms)
    n_test_pool = max(1, n_llms // 3)
    test_pool = np.sort(llm_order[:n_test_pool])
    train_pool = np.sort(llm_order[n_test_pool:])

    return SyntheticBenchmark(
        train_embeddings=embeddings[train_idx],
        val_embeddings=embeddings[val_idx],
        test_embeddings=embeddings[test_idx],
        train_errors_train_pool=errors[np.ix_(train_idx, train_pool)],
        val_errors_train_pool=errors[np.ix_(val_idx, train_pool)],
        val_errors_test_pool=errors[np.ix_(val_idx, test_pool)],
        test_errors_test_pool=errors[np.ix_(test_idx, test_pool)],
        train_pool_costs=costs[train_pool],
        test_pool_costs=costs[test_pool],
        test_true_error_rates=error_probability[np.ix_(test_idx, test_pool)],
        train_pool_names=[f"llm-{m:02d}" for m in train_pool],
        test_pool_names=[f"llm-{m:02d}" for m in test_pool],
    )
