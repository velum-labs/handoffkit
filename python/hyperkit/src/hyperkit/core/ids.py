"""Content-addressed identity for specs, cells, and shards.

Identity lives in the *materialized data*, never in the code that produced it,
so that reloading experiment code cannot change what a shard is. Hashing is over
canonical JSON (sorted keys, no whitespace), which makes hashes stable across
processes and Python versions.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence
from typing import Any


def canonical_json(value: Any) -> str:
    """Deterministic JSON: sorted keys, compact separators, UTF-8 preserved."""

    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def hash_obj(value: Any, *, length: int = 16) -> str:
    """Stable short hash of a JSON-serializable object."""

    digest = hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()
    return digest[:length]


def spec_hash(value: Any) -> str:
    """Hash for a topology/SUT spec (used as a cell coordinate)."""

    return hash_obj(value, length=16)


def hash_ids(ids: Sequence[str]) -> str:
    """Stable dataset/manifest hash over a sorted instance-id list."""

    payload = "\n".join(sorted(ids))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]
