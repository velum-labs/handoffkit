"""FusionKit lab loop tooling lives here so experiments become repeatable commands.

The Stage 0 package exposes only read-only configuration and model registry
plumbing; later stages add the runners that spend money and write lab artifacts.
"""

from __future__ import annotations

__all__ = ["__version__"]

__version__ = "0.1.0"
