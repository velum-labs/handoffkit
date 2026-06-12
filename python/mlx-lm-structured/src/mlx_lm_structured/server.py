"""Drop-in replacement entry point for ``mlx_lm.server``.

``python -m mlx_lm_structured.server <mlx_lm server args...>`` behaves
exactly like ``python -m mlx_lm server`` plus support for structured
decoding request parameters (``response_format``, ``guided_json``,
``guided_regex``, ``guided_choice``).

The overlay monkeypatches internals of an exact-pinned mlx-lm version; a
version mismatch is a hard error so a silent pin bump cannot produce a
server that quietly ignores (or corrupts) constrained requests. Set
MLX_LM_STRUCTURED_ALLOW_VERSION_MISMATCH=1 to bypass at your own risk.
"""

from __future__ import annotations

import os

import mlx_lm
import mlx_lm.server as mlx_server

from mlx_lm_structured.patching import apply_patches

EXPECTED_MLX_LM_VERSION = "0.31.3"


def _check_version() -> None:
    actual = mlx_lm.__version__
    if actual == EXPECTED_MLX_LM_VERSION:
        return
    if os.environ.get("MLX_LM_STRUCTURED_ALLOW_VERSION_MISMATCH") == "1":
        return
    raise RuntimeError(
        f"mlx-lm-structured patches mlx-lm=={EXPECTED_MLX_LM_VERSION} but "
        f"found mlx-lm=={actual}. Install the pinned version, or set "
        "MLX_LM_STRUCTURED_ALLOW_VERSION_MISMATCH=1 if you have verified the "
        "patched seams are unchanged."
    )


def main() -> None:
    _check_version()
    apply_patches()
    mlx_server.main()


if __name__ == "__main__":
    main()
