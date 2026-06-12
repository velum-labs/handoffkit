"""Unit tests of the server seam wrappers with fakes (no mlx required)."""

from __future__ import annotations

import io
import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import numpy as np

from mlx_lm_structured.compile import IndexCache
from mlx_lm_structured.processor import StructuredLogitsProcessor
from mlx_lm_structured.seams import (
    REQUEST_ATTR,
    GeneratorHolder,
    make_generate_wrapper,
    make_handle_completion_wrapper,
    make_init_wrapper,
    make_logits_processors_wrapper,
)
from vocab_fixture import TOKEN_STRINGS, VOCAB_SIZE

MODEL_KEY = ("fake-model", None, None)


@dataclass
class FakeCompletionRequest:
    request_type: str = "chat"
    prompt: str = ""


@dataclass
class FakeLogitsArguments:
    logit_bias: Optional[Dict[int, float]] = None


@dataclass
class FakeGenerationArguments:
    logits: FakeLogitsArguments = field(default_factory=FakeLogitsArguments)


class FakeHandler:
    """The slice of APIHandler the handle_completion wrapper touches."""

    def __init__(self, body: Dict[str, Any]):
        self.body = body
        self.wfile = io.BytesIO()
        self.status: Optional[int] = None
        self.headers_ended = False

    def _set_completion_headers(self, status_code: int = 200) -> None:
        self.status = status_code

    def end_headers(self) -> None:
        self.headers_ended = True


class FakeProvider:
    def __init__(self, tokenizer: Any):
        self.model_key = MODEL_KEY
        self.tokenizer = tokenizer


class FakeGenerator:
    def __init__(self, tokenizer: Any):
        self.model_provider = FakeProvider(tokenizer)


def call_handle_completion(body: Dict[str, Any]):
    calls: List[Any] = []

    def original(self, request, stop_words):
        calls.append((request, stop_words))
        return "handled"

    wrapper = make_handle_completion_wrapper(original)
    handler = FakeHandler(body)
    request = FakeCompletionRequest()
    result = wrapper(handler, request, ["stop"])
    return handler, request, calls, result


def test_handle_completion_no_constraint_passthrough():
    handler, request, calls, result = call_handle_completion({"messages": []})
    assert result == "handled"
    assert calls == [(request, ["stop"])]
    assert getattr(request, REQUEST_ATTR, None) is None


def test_handle_completion_attaches_spec():
    body = {"response_format": {"type": "json_object"}}
    handler, request, calls, result = call_handle_completion(body)
    assert result == "handled"
    spec = getattr(request, REQUEST_ATTR)
    assert spec.kind == "json_schema"


def test_handle_completion_rejects_bad_spec_with_400():
    handler, request, calls, result = call_handle_completion(
        {"response_format": {"type": "yaml"}}
    )
    assert result is None
    assert calls == []
    assert handler.status == 400
    assert handler.headers_ended
    error = json.loads(handler.wfile.getvalue())
    assert "response_format" in error["error"]


def test_handle_completion_rejects_uncompilable_schema_with_400():
    handler, request, calls, result = call_handle_completion(
        {"guided_json": {"type": "nonsense"}}
    )
    assert result is None
    assert handler.status == 400


def test_generate_wrapper_moves_spec_to_args():
    captured: List[Any] = []

    def original(self, request, generation_args, progress_callback=None):
        captured.append((request, generation_args, progress_callback))
        return "generated"

    wrapper = make_generate_wrapper(original)
    _, request, _, _ = call_handle_completion(
        {"response_format": {"type": "json_object"}}
    )
    args = FakeGenerationArguments()
    result = wrapper(object(), request, args, progress_callback="cb")
    assert result == "generated"
    assert captured[0][2] == "cb"
    assert getattr(args.logits, REQUEST_ATTR).kind == "json_schema"


def test_generate_wrapper_without_spec_leaves_args_untouched():
    def original(self, request, generation_args, progress_callback=None):
        return "generated"

    wrapper = make_generate_wrapper(original)
    args = FakeGenerationArguments()
    wrapper(object(), FakeCompletionRequest(), args)
    assert getattr(args.logits, REQUEST_ATTR, None) is None


def test_init_wrapper_records_instance():
    holder = GeneratorHolder()
    inits: List[Any] = []

    def original(self, *args, **kwargs):
        inits.append((self, args, kwargs))

    wrapper = make_init_wrapper(original, holder)
    instance = object.__new__(FakeGenerator)
    wrapper(instance, "provider", cache="x")
    assert holder.instance is instance
    assert inits == [(instance, ("provider",), {"cache": "x"})]


def _spec_args(spec_body: Dict[str, Any]) -> FakeGenerationArguments:
    _, request, _, _ = call_handle_completion(spec_body)
    args = FakeGenerationArguments()
    wrapper = make_generate_wrapper(lambda self, r, a, **kw: None)
    wrapper(object(), request, args)
    return args


def test_logits_processors_wrapper_appends_structured_processor(tokenizer):
    holder = GeneratorHolder()
    holder.instance = FakeGenerator(tokenizer)
    existing = ["penalty-processor"]
    wrapper = make_logits_processors_wrapper(
        lambda args: list(existing), holder, IndexCache()
    )

    args = _spec_args({"guided_regex": "ab"})
    processors = wrapper(args)
    assert processors[:-1] == existing
    assert isinstance(processors[-1], StructuredLogitsProcessor)

    # The processor actually masks: only 'a'/'ab' tokens may start the match.
    token_ids = {s: i for i, s in enumerate(TOKEN_STRINGS)}
    logits = np.zeros((1, VOCAB_SIZE), dtype=np.float32)
    out = processors[-1](np.array([7, 7], dtype=np.int64), logits)
    assert set(np.flatnonzero(out[0] > -np.inf).tolist()) == {
        token_ids["a"],
        token_ids["ab"],
    }


def test_logits_processors_wrapper_without_spec_is_passthrough(tokenizer):
    holder = GeneratorHolder()
    holder.instance = FakeGenerator(tokenizer)
    original = ["p"]
    wrapper = make_logits_processors_wrapper(lambda args: original, holder, IndexCache())
    assert wrapper(FakeGenerationArguments()) is original


def test_logits_processors_wrapper_fails_open(tokenizer):
    """A compile failure must degrade to unconstrained, not raise."""
    holder = GeneratorHolder()
    holder.instance = FakeGenerator(tokenizer)

    class ExplodingCache(IndexCache):
        def index(self, *args, **kwargs):
            raise RuntimeError("boom")

    wrapper = make_logits_processors_wrapper(
        lambda args: ["p"], holder, ExplodingCache()
    )
    args = _spec_args({"guided_regex": "ab"})
    assert wrapper(args) == ["p"]


def test_fresh_processor_per_request(tokenizer):
    holder = GeneratorHolder()
    holder.instance = FakeGenerator(tokenizer)
    wrapper = make_logits_processors_wrapper(lambda args: [], holder, IndexCache())
    args = _spec_args({"guided_regex": "ab"})
    p1 = wrapper(args)[-1]
    p2 = wrapper(args)[-1]
    assert p1 is not p2
    # Same compiled Index is shared underneath (the cache works).
    assert p1._index is p2._index
