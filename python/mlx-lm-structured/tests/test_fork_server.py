"""Integration tests against the velum-labs/mlx-lm fork's server module.

Skipped unless an mlx-lm with the structured hooks is importable (mlx plus
the fork). The hook-free machinery is covered by the other test modules.
"""

from __future__ import annotations

import pickle

import numpy as np
import pytest

mlx_server = pytest.importorskip("mlx_lm.server")

if getattr(mlx_server, "STRUCTURED_FIELDS", None) is None:
    pytest.skip(
        "installed mlx-lm has no structured decoding hooks (not the fork)",
        allow_module_level=True,
    )

from mlx_lm_structured.processor import StructuredLogitsProcessor  # noqa: E402
from vocab_fixture import VOCAB_SIZE, TOKEN_STRINGS  # noqa: E402

TOKEN_IDS = {s: i for i, s in enumerate(TOKEN_STRINGS)}


def make_args(structured):
    return mlx_server.GenerationArguments(
        model=mlx_server.ModelDescription(model="m", draft="d", adapter=None),
        sampling=mlx_server.SamplingArguments(
            temperature=0.0,
            top_p=1.0,
            top_k=0,
            min_p=0.0,
            xtc_probability=0.0,
            xtc_threshold=0.0,
        ),
        logits=mlx_server.LogitsProcessorArguments(
            logit_bias=None,
            repetition_penalty=0.0,
            repetition_context_size=20,
            presence_penalty=0.0,
            presence_context_size=20,
            frequency_penalty=0.0,
            frequency_context_size=20,
            structured=structured,
        ),
        stop_words=[],
        max_tokens=16,
        num_draft_tokens=0,
        logprobs=False,
        top_logprobs=-1,
        seed=None,
        chat_template_kwargs=None,
    )


def test_hooks_are_bound():
    assert mlx_server.parse_request_constraint is not None
    assert mlx_server.make_constraint_processor is not None


def test_make_logits_processors_without_constraint(tokenizer):
    processors = mlx_server._make_logits_processors(
        make_args(None), tokenizer, ("m", None, None)
    )
    assert processors == []


def test_make_logits_processors_appends_constraint(tokenizer):
    spec = mlx_server.parse_request_constraint({"guided_regex": "ab"})
    processors = mlx_server._make_logits_processors(
        make_args(spec), tokenizer, ("fork-test-model", None, None)
    )
    assert len(processors) == 1
    assert isinstance(processors[0], StructuredLogitsProcessor)

    logits = np.zeros((1, VOCAB_SIZE), dtype=np.float32)
    out = processors[0](np.array([7, 7], dtype=np.int64), logits)
    assert set(np.flatnonzero(np.asarray(out)[0] > -np.inf).tolist()) == {
        TOKEN_IDS["a"],
        TOKEN_IDS["ab"],
    }


def test_structured_args_survive_pickling(tokenizer):
    spec = mlx_server.parse_request_constraint({"guided_regex": "a+"})
    args = make_args(spec)
    restored = pickle.loads(pickle.dumps(args))
    assert restored.logits.structured == spec
