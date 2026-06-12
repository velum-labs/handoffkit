"""Parsing of structured-output request parameters into a ConstraintSpec.

This module is pure: no outlines-core or mlx imports, so request validation
is cheap and the parsing logic is testable anywhere. Turning a spec into a
regex / compiled FSM lives in `compile.py`.

Accepted request fields (mutually exclusive):

- ``response_format`` (OpenAI):
    ``{"type": "text"}``                       -> no constraint
    ``{"type": "json_object"}``                -> any JSON object
    ``{"type": "json_schema", "json_schema": {"schema": {...}}}``
    (a top-level ``"schema"`` key is also accepted for lenient clients)
- ``guided_json`` (vLLM extension): a JSON schema as a dict or JSON string
- ``guided_regex`` (vLLM extension): a regex the output must match
- ``guided_choice`` (vLLM extension): a list of allowed output strings
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Literal, Optional, Tuple


class ConstraintSpecError(ValueError):
    """A structured-output parameter the request supplied is invalid."""


# Schema used for response_format {"type": "json_object"}: any JSON object.
JSON_OBJECT_SCHEMA = '{"type": "object"}'


@dataclass(frozen=True)
class ConstraintSpec:
    """A canonical, picklable description of a decoding constraint.

    ``payload`` holds the canonical form for each kind:
      - ``json_schema``: the schema serialized with sorted keys
      - ``regex``: the regex pattern
      - ``choice``: the choices serialized as a sorted-key JSON list
    """

    kind: Literal["json_schema", "regex", "choice"]
    payload: str

    @property
    def cache_key(self) -> str:
        digest = hashlib.sha256(
            f"{self.kind}\x00{self.payload}".encode("utf-8")
        ).hexdigest()
        return f"{self.kind}:{digest}"

    def choices(self) -> List[str]:
        if self.kind != "choice":
            raise ValueError("choices() is only valid for choice constraints")
        return json.loads(self.payload)


def _canonical_schema(schema: Any, field: str) -> str:
    """Validate and canonicalize a JSON schema given as a dict or JSON text."""
    if isinstance(schema, str):
        try:
            schema = json.loads(schema)
        except json.JSONDecodeError as e:
            raise ConstraintSpecError(f"'{field}' is not valid JSON: {e}") from e
    if isinstance(schema, bool):
        # JSON Schema allows `true` (anything) / `false` (nothing); neither is
        # a meaningful decoding constraint.
        raise ConstraintSpecError(f"'{field}' must be a JSON schema object")
    if not isinstance(schema, dict):
        raise ConstraintSpecError(f"'{field}' must be a JSON schema object")
    return json.dumps(schema, sort_keys=True, separators=(",", ":"))


def _parse_response_format(value: Any) -> Optional[ConstraintSpec]:
    if not isinstance(value, dict):
        raise ConstraintSpecError("'response_format' must be an object")
    fmt_type = value.get("type")
    if fmt_type == "text":
        return None
    if fmt_type == "json_object":
        return ConstraintSpec(kind="json_schema", payload=JSON_OBJECT_SCHEMA)
    if fmt_type == "json_schema":
        inner = value.get("json_schema")
        if isinstance(inner, dict) and "schema" in inner:
            schema = inner["schema"]
        elif "schema" in value:
            schema = value["schema"]
        else:
            raise ConstraintSpecError(
                "'response_format' of type 'json_schema' requires "
                "'json_schema': {'schema': {...}}"
            )
        return ConstraintSpec(
            kind="json_schema",
            payload=_canonical_schema(schema, "response_format.json_schema.schema"),
        )
    raise ConstraintSpecError(
        f"unsupported 'response_format' type: {fmt_type!r} "
        "(expected 'text', 'json_object' or 'json_schema')"
    )


def _parse_guided_choice(value: Any) -> ConstraintSpec:
    if not isinstance(value, list) or not value:
        raise ConstraintSpecError("'guided_choice' must be a non-empty list")
    choices: List[str] = []
    for item in value:
        if isinstance(item, str):
            choices.append(item)
        elif isinstance(item, (int, float)) and not isinstance(item, bool):
            choices.append(json.dumps(item))
        else:
            raise ConstraintSpecError(
                "'guided_choice' entries must be strings or numbers"
            )
    if any(choice == "" for choice in choices):
        raise ConstraintSpecError("'guided_choice' entries must be non-empty")
    return ConstraintSpec(
        kind="choice", payload=json.dumps(choices, separators=(",", ":"))
    )


def parse_constraint_spec(body: Dict[str, Any]) -> Optional[ConstraintSpec]:
    """Extract the decoding constraint from a request body, if any.

    Raises ConstraintSpecError when the parameters are malformed or when more
    than one constraint source is supplied.
    """
    present: List[Tuple[str, Any]] = [
        (field, body[field])
        for field in ("response_format", "guided_json", "guided_regex", "guided_choice")
        if body.get(field) is not None
    ]
    if not present:
        return None

    specs: List[ConstraintSpec] = []
    for field, value in present:
        if field == "response_format":
            spec = _parse_response_format(value)
            if spec is not None:
                specs.append(spec)
        elif field == "guided_json":
            specs.append(
                ConstraintSpec(
                    kind="json_schema",
                    payload=_canonical_schema(value, "guided_json"),
                )
            )
        elif field == "guided_regex":
            if not isinstance(value, str) or not value:
                raise ConstraintSpecError("'guided_regex' must be a non-empty string")
            specs.append(ConstraintSpec(kind="regex", payload=value))
        elif field == "guided_choice":
            specs.append(_parse_guided_choice(value))

    if len(specs) > 1:
        fields = ", ".join(repr(field) for field, _ in present)
        raise ConstraintSpecError(
            f"conflicting structured-output parameters: {fields} "
            "(provide at most one constraint)"
        )
    return specs[0] if specs else None


def choices_to_regex(choices: List[str]) -> str:
    """Build an alternation regex matching exactly one of the choices."""
    return "(" + "|".join(re.escape(choice) for choice in choices) + ")"
