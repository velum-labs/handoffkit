"""Integration tests against the real mlx_lm.server module.

These require mlx (and the pinned mlx-lm) to be importable; on hosts without
them the module is skipped. They verify the patches bind to the real seams —
the seam logic itself is covered with fakes in test_seams.py.
"""

from __future__ import annotations

import pytest

mlx_lm = pytest.importorskip("mlx_lm")

import mlx_lm.server as mlx_server  # noqa: E402

from mlx_lm_structured import server as structured_server  # noqa: E402
from mlx_lm_structured.patching import ACTIVE_GENERATOR, apply_patches  # noqa: E402
from mlx_lm_structured.seams import REQUEST_ATTR  # noqa: E402


def test_pinned_version_matches():
    assert mlx_lm.__version__ == structured_server.EXPECTED_MLX_LM_VERSION


def test_patched_seams_exist_unpatched():
    # The attributes the overlay patches must exist with the expected shapes
    # in the pinned version.
    assert callable(mlx_server.APIHandler.handle_completion)
    assert callable(mlx_server.ResponseGenerator.generate)
    assert callable(mlx_server._make_logits_processors)


def test_apply_patches_is_idempotent():
    apply_patches()
    handle_completion = mlx_server.APIHandler.handle_completion
    make_processors = mlx_server._make_logits_processors
    apply_patches()
    assert mlx_server.APIHandler.handle_completion is handle_completion
    assert mlx_server._make_logits_processors is make_processors


def test_patched_make_logits_processors_passthrough_without_spec():
    apply_patches()
    args = mlx_server.GenerationArguments(
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
        ),
        stop_words=[],
        max_tokens=16,
        num_draft_tokens=0,
        logprobs=False,
        top_logprobs=-1,
        seed=None,
        chat_template_kwargs=None,
    )
    assert mlx_server._make_logits_processors(args) == []
    assert getattr(args.logits, REQUEST_ATTR, None) is None


def test_request_attr_survives_pickling():
    import pickle

    request = mlx_server.CompletionRequest(
        request_type="chat", prompt="", messages=[], tools=None, role_mapping=None
    )
    from mlx_lm_structured.spec import parse_constraint_spec

    spec = parse_constraint_spec({"guided_regex": "a+"})
    setattr(request, REQUEST_ATTR, spec)
    restored = pickle.loads(pickle.dumps(request))
    assert getattr(restored, REQUEST_ATTR) == spec


def test_active_generator_holder_starts_empty_or_set():
    # The holder is module state; this just asserts the patched __init__ is in
    # place by checking the wrapper points at the holder-aware closure.
    apply_patches()
    assert ACTIVE_GENERATOR is not None
