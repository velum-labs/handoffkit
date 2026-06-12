import pytest
from outlines_core import Index

from mlx_lm_structured.compile import (
    IndexCache,
    build_vocabulary,
    spec_to_regex,
)
from mlx_lm_structured.spec import ConstraintSpec, ConstraintSpecError

from .conftest import EOS_ID, SECONDARY_EOS_ID


def test_spec_to_regex_json_schema():
    spec = ConstraintSpec(kind="json_schema", payload='{"type": "integer"}')
    regex = spec_to_regex(spec)
    assert regex  # outlines-core produced something compilable
    import re

    assert re.fullmatch(regex, "42")
    assert not re.fullmatch(regex, '"x"')


def test_spec_to_regex_invalid_schema():
    spec = ConstraintSpec(kind="json_schema", payload='{"type": "nonsense"}')
    with pytest.raises(ConstraintSpecError, match="unsupported JSON schema"):
        spec_to_regex(spec)


def test_spec_to_regex_passthrough_and_choice():
    assert spec_to_regex(ConstraintSpec(kind="regex", payload="a+")) == "a+"
    assert (
        spec_to_regex(ConstraintSpec(kind="choice", payload='["x", "y"]')) == "(x|y)"
    )


def test_build_vocabulary_excludes_all_eos_ids(tokenizer):
    vocabulary, eos_id, eos_ids = build_vocabulary(tokenizer)
    assert eos_id == EOS_ID
    assert eos_ids == sorted({EOS_ID, SECONDARY_EOS_ID})
    # The vocabulary compiles into a working Index: a quick smoke test that
    # eos exclusion did not break construction.
    index = Index("a+", vocabulary)
    assert index is not None


def test_build_vocabulary_requires_eos(tokenizer):
    tokenizer.eos_token_id = None
    tokenizer.eos_token_ids = set()
    with pytest.raises(ValueError, match="eos_token_id"):
        build_vocabulary(tokenizer)


def test_index_cache_reuses_compiled_indexes(tokenizer):
    cache = IndexCache()
    spec = ConstraintSpec(kind="regex", payload="ab")
    index1, _, _ = cache.index(("model", None, None), tokenizer, spec)
    index2, _, _ = cache.index(("model", None, None), tokenizer, spec)
    assert index1 is index2


def test_index_cache_distinguishes_constraints_and_models(tokenizer):
    cache = IndexCache()
    spec_a = ConstraintSpec(kind="regex", payload="ab")
    spec_b = ConstraintSpec(kind="regex", payload="ba")
    index_a, _, _ = cache.index(("m1", None, None), tokenizer, spec_a)
    index_b, _, _ = cache.index(("m1", None, None), tokenizer, spec_b)
    index_c, _, _ = cache.index(("m2", None, None), tokenizer, spec_a)
    assert index_a is not index_b
    assert index_a is not index_c


def test_index_cache_lru_eviction(tokenizer):
    cache = IndexCache(max_indexes=2)
    model = ("m", None, None)
    spec_a = ConstraintSpec(kind="regex", payload="a")
    spec_b = ConstraintSpec(kind="regex", payload="b")
    spec_c = ConstraintSpec(kind="regex", payload="c")
    index_a, _, _ = cache.index(model, tokenizer, spec_a)
    cache.index(model, tokenizer, spec_b)
    cache.index(model, tokenizer, spec_c)  # evicts spec_a
    index_a2, _, _ = cache.index(model, tokenizer, spec_a)
    assert index_a is not index_a2


def test_index_cache_compile_error_is_spec_error(tokenizer):
    cache = IndexCache()
    # Lookaheads are valid Python regex but not supported by the FSM compiler.
    spec = ConstraintSpec(kind="regex", payload="(?=a)a")
    with pytest.raises(ConstraintSpecError, match="failed to compile"):
        cache.index(("m", None, None), tokenizer, spec)
