"""Numpy/numba kernel backend.

Used by the test suite (and any host without Apple Silicon). The mask
allocation and fill are identical to the mlx backend — outlines-core fills a
CPU-side numpy int32 bitmask in both cases — only the application of the mask
to the logits differs.
"""

from __future__ import annotations

from typing import List, Sequence

import numpy as np
from outlines_core import Guide
from outlines_core.kernels.numpy import (
    allocate_token_bitmask,
    apply_token_bitmask_inplace,
    fill_next_token_bitmask,
)


class NumpyBackend:
    name = "numpy"

    def allocate_mask(self, vocab_size: int) -> np.ndarray:
        return allocate_token_bitmask(vocab_size)

    def fill_mask(self, guide: Guide, mask: np.ndarray) -> None:
        fill_next_token_bitmask(guide, mask)

    def apply_mask(self, logits, mask: np.ndarray):
        out = np.array(logits, dtype=np.float32, copy=True)
        apply_token_bitmask_inplace(out, mask)
        return out

    def make_keep_mask(self, width: int, token_ids: Sequence[int]) -> np.ndarray:
        keep = np.zeros(width, dtype=bool)
        keep[list(token_ids)] = True
        return keep

    def apply_keep(self, logits, keep_mask: np.ndarray):
        return np.where(keep_mask, logits, -np.inf)

    def to_int_list(self, tokens) -> List[int]:
        return [int(t) for t in np.asarray(tokens).reshape(-1).tolist()]
