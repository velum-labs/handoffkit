"""Built-in benchmark adapters. Importing this package registers them."""

from __future__ import annotations

from hyperkit.adapters import livecodebench as _livecodebench  # noqa: F401  (registers on import)
from hyperkit.adapters import swebench as _swebench  # noqa: F401
from hyperkit.adapters import terminal_bench as _terminal_bench  # noqa: F401

__all__ = ["_livecodebench", "_swebench", "_terminal_bench"]
