"""The integration surface consumed by the velum-labs/mlx-lm fork.

The fork's server imports these two functions optionally (its behavior
matches upstream mlx-lm when this package is absent):

- ``parse_request_constraint`` runs on the HTTP thread: it parses and fully
  validates the structured-output request parameters, raising
  ``ConstraintSpecError`` (a ``ValueError``) that the server turns into an
  HTTP 400.
- ``make_constraint_processor`` runs on the generation thread when the
  request is set up: it compiles (or fetches from cache) the constraint's
  FSM for the loaded model and returns a fresh single-request processor.
"""

from __future__ import annotations

from typing import Any, Dict, Hashable, Optional

from mlx_lm_structured.compile import GLOBAL_INDEX_CACHE, spec_to_regex
from mlx_lm_structured.processor import StructuredLogitsProcessor
from mlx_lm_structured.spec import ConstraintSpec, parse_constraint_spec


def parse_request_constraint(body: Dict[str, Any]) -> Optional[ConstraintSpec]:
    """Parse the structured-output parameters of a request body, if any.

    Raises ConstraintSpecError for malformed parameters, conflicting
    constraints, and constraints that cannot be compiled (bad JSON schemas,
    regex features outside the FSM subset), so the server can reject the
    request before generation starts.
    """
    spec = parse_constraint_spec(body)
    if spec is not None:
        # Compile to the regex now: catches bad schemas/regexes with a clean
        # request-time error instead of failing during generation setup.
        spec_to_regex(spec)
    return spec


def make_constraint_processor(
    spec: ConstraintSpec, tokenizer: Any, model_key: Hashable
) -> StructuredLogitsProcessor:
    """Build a fresh per-request logits processor enforcing the constraint.

    The compiled FSM Index is cached per (model, constraint) and the
    vocabulary per model; only the lightweight Guide state is per-request.
    """
    index, _eos_id, eos_ids = GLOBAL_INDEX_CACHE.index(model_key, tokenizer, spec)
    return StructuredLogitsProcessor(index, eos_ids)
