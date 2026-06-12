"""Compilation of ConstraintSpecs into outlines-core FSM Indexes.

Two caches keep request latency sane:

- one ``Vocabulary`` per model (building it walks the full tokenizer vocab,
  ~0.3s for a 150k-token vocabulary), and
- an LRU of compiled ``Index`` objects keyed by (model, constraint), since
  regex -> FSM compilation can take ~0.1s-seconds for complex schemas.

Guides created from a cached Index are cheap per-request state machines.
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from typing import Any, Dict, Hashable, List, Tuple

from outlines_core import Index, Vocabulary
from outlines_core.json_schema import build_regex_from_schema

from mlx_lm_structured.spec import ConstraintSpec, ConstraintSpecError, choices_to_regex

# SentencePiece encodes a leading space as this marker; convert_tokens_to_string
# strips it for a single token, so it is restored manually (same handling as
# outlines' TransformerTokenizer).
_SPIECE_UNDERLINE = "\u2581"

_INDEX_CACHE_SIZE = 32


def spec_to_regex(spec: ConstraintSpec) -> str:
    """Convert a parsed constraint into the regex outlines-core compiles."""
    if spec.kind == "json_schema":
        try:
            return build_regex_from_schema(spec.payload)
        except (ValueError, TypeError) as e:
            raise ConstraintSpecError(f"unsupported JSON schema: {e}") from e
    if spec.kind == "regex":
        return spec.payload
    if spec.kind == "choice":
        return choices_to_regex(spec.choices())
    raise ConstraintSpecError(f"unknown constraint kind: {spec.kind!r}")


def _token_to_string(tokenizer: Any, token: str) -> str:
    string = tokenizer.convert_tokens_to_string([token])
    if token.startswith(_SPIECE_UNDERLINE) or token == "<0x20>":
        return " " + string
    return string


def build_vocabulary(tokenizer: Any) -> Tuple[Vocabulary, int, List[int]]:
    """Build an outlines-core Vocabulary from an mlx-lm TokenizerWrapper.

    Token strings are normalized the same way outlines does for its mlx-lm
    integration: each vocab token is decoded with ``convert_tokens_to_string``
    (grouping duplicate decodings under one string), and every EOS token id is
    excluded — outlines-core models EOS itself and rejects it in the map.

    Returns (vocabulary, primary_eos_id, all_eos_ids).
    """
    eos_token_id = tokenizer.eos_token_id
    if eos_token_id is None:
        raise ValueError("tokenizer has no eos_token_id; cannot constrain decoding")
    # mlx-lm's TokenizerWrapper exposes the full set of stop ids (possibly
    # larger than the HF eos); plain HF tokenizers only have the one.
    eos_ids = set(getattr(tokenizer, "eos_token_ids", None) or [eos_token_id])
    eos_ids.add(eos_token_id)

    formatted: Dict[str, List[int]] = {}
    for token, token_id in tokenizer.get_vocab().items():
        if token_id in eos_ids:
            continue
        token_str = _token_to_string(tokenizer, token)
        formatted.setdefault(token_str, []).append(token_id)

    return Vocabulary(eos_token_id, formatted), eos_token_id, sorted(eos_ids)


class IndexCache:
    """Thread-safe caches for vocabularies (per model) and Indexes (LRU)."""

    def __init__(self, max_indexes: int = _INDEX_CACHE_SIZE):
        self._lock = threading.Lock()
        self._max_indexes = max_indexes
        self._vocabularies: Dict[Hashable, Tuple[Vocabulary, int, List[int]]] = {}
        self._indexes: "OrderedDict[Tuple[Hashable, str], Index]" = OrderedDict()

    def vocabulary(
        self, model_key: Hashable, tokenizer: Any
    ) -> Tuple[Vocabulary, int, List[int]]:
        with self._lock:
            cached = self._vocabularies.get(model_key)
        if cached is not None:
            return cached
        built = build_vocabulary(tokenizer)
        with self._lock:
            # Keep only the current model's vocabulary: mlx_lm.server holds a
            # single loaded model at a time, so older entries are dead weight.
            self._vocabularies = {model_key: built}
        return built

    def index(
        self, model_key: Hashable, tokenizer: Any, spec: ConstraintSpec
    ) -> Tuple[Index, int, List[int]]:
        """Return (index, primary_eos_id, all_eos_ids) for the constraint."""
        cache_key = (model_key, spec.cache_key)
        with self._lock:
            index = self._indexes.get(cache_key)
            if index is not None:
                self._indexes.move_to_end(cache_key)
        vocabulary, eos_id, eos_ids = self.vocabulary(model_key, tokenizer)
        if index is None:
            regex = spec_to_regex(spec)
            try:
                index = Index(regex, vocabulary)
            except ValueError as e:
                raise ConstraintSpecError(
                    f"failed to compile constraint to an FSM: {e}"
                ) from e
            with self._lock:
                self._indexes[cache_key] = index
                while len(self._indexes) > self._max_indexes:
                    self._indexes.popitem(last=False)
        return index, eos_id, eos_ids


# Process-wide cache used by the server patches.
GLOBAL_INDEX_CACHE = IndexCache()
