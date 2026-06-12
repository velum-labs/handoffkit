"""Wrapper factories for the mlx_lm.server seams.

These are pure closures over the originals — no mlx imports — so the seam
behavior is unit-testable on hosts without mlx. `patching.py` binds them to
the real mlx_lm.server objects.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Callable, Optional

from mlx_lm_structured.compile import GLOBAL_INDEX_CACHE, IndexCache, spec_to_regex
from mlx_lm_structured.processor import StructuredLogitsProcessor
from mlx_lm_structured.spec import ConstraintSpecError, parse_constraint_spec

REQUEST_ATTR = "structured_constraint"


class GeneratorHolder:
    """Records the live ResponseGenerator so the logits-processor factory can
    reach the model provider's tokenizer and model key.

    mlx_lm.server creates exactly one ResponseGenerator per process (on every
    distributed rank), so a single slot is accurate.
    """

    def __init__(self) -> None:
        self.instance: Optional[Any] = None


def make_init_wrapper(original_init: Callable, holder: GeneratorHolder) -> Callable:
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        holder.instance = self
        original_init(self, *args, **kwargs)

    return __init__


def make_handle_completion_wrapper(original_handle_completion: Callable) -> Callable:
    def handle_completion(self, request: Any, stop_words: Any) -> Any:
        try:
            spec = parse_constraint_spec(self.body)
            if spec is not None:
                # Compile the constraint to its regex now: it catches bad
                # schemas/regexes on the HTTP thread with a clean 400 instead
                # of failing later inside the generation thread.
                spec_to_regex(spec)
        except ConstraintSpecError as e:
            self._set_completion_headers(400)
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())
            return None
        if spec is not None:
            setattr(request, REQUEST_ATTR, spec)
        return original_handle_completion(self, request, stop_words)

    return handle_completion


def make_generate_wrapper(original_generate: Callable) -> Callable:
    def generate(self, request: Any, generation_args: Any, *args: Any, **kwargs: Any):
        spec = getattr(request, REQUEST_ATTR, None)
        if spec is not None:
            # LogitsProcessorArguments is a plain dataclass (no slots): the
            # extra attribute lives in __dict__ and survives pickling, so it
            # reaches every distributed rank along with the args.
            setattr(generation_args.logits, REQUEST_ATTR, spec)
        return original_generate(self, request, generation_args, *args, **kwargs)

    return generate


def make_logits_processors_wrapper(
    original_make_logits_processors: Callable,
    holder: GeneratorHolder,
    index_cache: IndexCache = GLOBAL_INDEX_CACHE,
) -> Callable:
    def _make_logits_processors(args: Any):
        processors = original_make_logits_processors(args)
        spec = getattr(args.logits, REQUEST_ATTR, None)
        if spec is None:
            return processors

        provider = holder.instance.model_provider
        try:
            index, _eos_id, eos_ids = index_cache.index(
                provider.model_key, provider.tokenizer, spec
            )
            # The structured processor goes last so penalties and logit bias
            # cannot unmask forbidden tokens (they cannot lift -inf anyway,
            # but the ordering makes it structurally true).
            processors = list(processors) + [StructuredLogitsProcessor(index, eos_ids)]
        except Exception:
            # This runs on the generation thread where an exception would
            # kill generation for every in-flight request (the batch insert
            # has no per-request error path). An unconstrained completion is
            # the safer failure mode; the cause lands in the server log.
            logging.exception(
                "structured decoding disabled for this request: failed to "
                "build the constraint processor"
            )
        return processors

    return _make_logits_processors
