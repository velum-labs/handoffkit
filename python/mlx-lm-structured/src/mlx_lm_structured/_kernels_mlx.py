"""MLX kernel backend used in production inside mlx_lm.server.

The bitmask itself is a CPU-side numpy int32 array in outlines-core's layout
(bit j of the mask = token j allowed, packed little-endian into int32 words);
``Guide.write_mask_into`` fills it directly. Only applying the mask to the
logits touches the MLX device: on Apple GPUs the fused Metal kernel shipped
by outlines-core is used, while on other mlx backends (CPU, CUDA) the mask is
expanded to booleans and applied with regular mlx ops.

``outlines_core.kernels.mlx`` compiles its Metal kernel at import time and
therefore cannot even be imported without a Metal device, hence the
conditional module-level import.
"""

from __future__ import annotations

from typing import Callable, List, Optional, Sequence

import mlx.core as mx
import numpy as np
from outlines_core import Guide

if mx.metal.is_available():
    from outlines_core.kernels.mlx import apply_token_bitmask
else:
    apply_token_bitmask: Optional[Callable] = None  # type: ignore[no-redef]


def _mask_to_bool(mask: np.ndarray, width: int) -> np.ndarray:
    """Expand the packed little-endian int32 bitmask to a boolean vector."""
    bits = np.unpackbits(mask.view(np.uint8), bitorder="little")
    return bits[:width].astype(bool)


class MLXBackend:
    name = "mlx"

    def allocate_mask(self, vocab_size: int) -> np.ndarray:
        return np.full((1, (vocab_size + 31) // 32), -1, dtype=np.int32)

    def fill_mask(self, guide: Guide, mask: np.ndarray) -> None:
        guide.write_mask_into(mask.ctypes.data, mask.size, mask.itemsize)

    def apply_mask(self, logits: mx.array, mask: np.ndarray) -> mx.array:
        if apply_token_bitmask is not None:
            return apply_token_bitmask(logits, mask)
        keep = mx.array(_mask_to_bool(mask, logits.shape[-1]))
        return self.apply_keep(logits, keep)

    def make_keep_mask(self, width: int, token_ids: Sequence[int]) -> mx.array:
        keep = np.zeros(width, dtype=bool)
        keep[list(token_ids)] = True
        return mx.array(keep)

    def apply_keep(self, logits: mx.array, keep_mask: mx.array) -> mx.array:
        # The scalar -inf is weakly typed in mlx and adopts the logits dtype.
        return mx.where(keep_mask, mx.array(logits), -float("inf"))

    def to_int_list(self, tokens: mx.array) -> List[int]:
        return tokens.reshape(-1).tolist()
