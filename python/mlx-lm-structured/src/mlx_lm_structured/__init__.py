"""Structured/constrained decoding for mlx-lm's OpenAI-compatible server.

This package holds the constraint machinery (request parsing, FSM
compilation and caching, the logits processor). The velum-labs/mlx-lm fork
imports `mlx_lm_structured.integration` optionally and enforces structured
output whenever this package is installed alongside it.
"""

from mlx_lm_structured.integration import (
    make_constraint_processor,
    parse_request_constraint,
)
from mlx_lm_structured.processor import StructuredLogitsProcessor
from mlx_lm_structured.spec import (
    ConstraintSpec,
    ConstraintSpecError,
    parse_constraint_spec,
)

__all__ = [
    "ConstraintSpec",
    "ConstraintSpecError",
    "StructuredLogitsProcessor",
    "make_constraint_processor",
    "parse_constraint_spec",
    "parse_request_constraint",
]
