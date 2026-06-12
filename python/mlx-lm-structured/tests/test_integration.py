"""Tests of the integration surface the mlx-lm fork consumes."""

from __future__ import annotations

import numpy as np
import pytest

from mlx_lm_structured.integration import (
    make_constraint_processor,
    parse_request_constraint,
)
from mlx_lm_structured.processor import StructuredLogitsProcessor
from mlx_lm_structured.spec import ConstraintSpecError
from vocab_fixture import TOKEN_STRINGS, VOCAB_SIZE

TOKEN_IDS = {s: i for i, s in enumerate(TOKEN_STRINGS)}


def test_parse_no_constraint():
    assert parse_request_constraint({"messages": [], "temperature": 0.2}) is None
    assert parse_request_constraint({"response_format": {"type": "text"}}) is None


def test_parse_valid_constraint():
    spec = parse_request_constraint({"guided_regex": "ab"})
    assert spec is not None
    assert spec.kind == "regex"


def test_parse_malformed_constraint_raises_value_error():
    # The fork catches ValueError to produce its HTTP 400; ConstraintSpecError
    # must remain a ValueError subclass.
    with pytest.raises(ValueError):
        parse_request_constraint({"response_format": {"type": "yaml"}})
    with pytest.raises(ConstraintSpecError):
        parse_request_constraint({"guided_choice": []})


def test_parse_rejects_uncompilable_constraints_at_request_time():
    with pytest.raises(ConstraintSpecError, match="unsupported JSON schema"):
        parse_request_constraint({"guided_json": {"type": "nonsense"}})


def test_make_constraint_processor_masks(tokenizer):
    spec = parse_request_constraint({"guided_regex": "ab"})
    processor = make_constraint_processor(spec, tokenizer, ("model-mask", None, None))
    assert isinstance(processor, StructuredLogitsProcessor)

    logits = np.zeros((1, VOCAB_SIZE), dtype=np.float32)
    out = processor(np.array([7, 7], dtype=np.int64), logits)
    assert set(np.flatnonzero(out[0] > -np.inf).tolist()) == {
        TOKEN_IDS["a"],
        TOKEN_IDS["ab"],
    }


def test_fresh_processor_per_request_with_shared_index(tokenizer):
    spec = parse_request_constraint({"guided_regex": "ab"})
    key = ("model-cache", None, None)
    p1 = make_constraint_processor(spec, tokenizer, key)
    p2 = make_constraint_processor(spec, tokenizer, key)
    assert p1 is not p2
    assert p1._index is p2._index
