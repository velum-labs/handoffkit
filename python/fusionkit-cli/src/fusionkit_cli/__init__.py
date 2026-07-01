"""Public API for the FusionKit Python CLI package.

The package exposes the Typer application object that backs the PyPI `fusionkit`
console script. Generated code documentation uses this docstring to explain the
CLI package surface.
"""

from fusionkit_cli.main import app

__all__ = ["app"]
