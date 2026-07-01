"""Public API for optional FusionKit MLX helpers.

The package exposes utilities for constructing the `mlx_lm.server` command used
by local Apple Silicon model serving. Generated code documentation uses this
docstring to describe the optional MLX integration surface.
"""

from fusionkit_mlx.launcher import MlxServerCommand, build_mlx_lm_server_command

__all__ = ["MlxServerCommand", "build_mlx_lm_server_command"]
