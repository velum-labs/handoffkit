"""Kernel backend selection.

Production (inside mlx_lm.server) uses the MLX backend; the numpy backend
exists so the processor logic is fully testable on hosts without mlx. Each
backend has optional dependencies (mlx for one, numba for the other), so both
imports are availability-probed at module load and only the requested backend
needs its dependencies present.
"""

from __future__ import annotations

from typing import Any, Optional

try:
    from mlx_lm_structured._kernels_mlx import MLXBackend
except ImportError:  # mlx not installed (e.g. hosts without Apple Silicon)
    MLXBackend = None  # type: ignore[assignment,misc]

try:
    from mlx_lm_structured._kernels_numpy import NumpyBackend
except ImportError:  # numba not installed (it is only a dev/test dependency)
    NumpyBackend = None  # type: ignore[assignment,misc]

# A backend instance; both classes implement the same informal protocol
# (allocate_mask / fill_mask / apply_mask / make_keep_mask / apply_keep /
# to_int_list).
Backend = Any


def get_backend(name: Optional[str] = None) -> Backend:
    """Return the kernel backend, defaulting to mlx when available."""
    if name == "numpy":
        if NumpyBackend is None:
            raise ImportError(
                "the numpy kernel backend requires 'numba', which is not "
                "installed on this host"
            )
        return NumpyBackend()
    if name == "mlx" or name is None:
        if MLXBackend is not None:
            return MLXBackend()
        if name == "mlx":
            raise ImportError(
                "the mlx kernel backend requires the 'mlx' package, which is "
                "not installed on this host"
            )
        if NumpyBackend is not None:
            return NumpyBackend()
        raise ImportError(
            "no kernel backend available: install 'mlx' (production) or "
            "'numba' (tests)"
        )
    raise ValueError(f"unknown kernel backend: {name!r}")
