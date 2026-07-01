"""Public API for the FusionKit HTTP server package.

The package exposes `create_app`, the FastAPI application factory used by the
Python CLI, local development servers, and tests. Generated code documentation
uses this docstring to describe the server package surface.
"""

from fusionkit_server.app import create_app

__all__ = ["create_app"]
