import json

import pytest

from mlx_lm_structured.spec import (
    JSON_OBJECT_SCHEMA,
    ConstraintSpecError,
    choices_to_regex,
    parse_constraint_spec,
)

SCHEMA = {"type": "object", "properties": {"a": {"type": "integer"}}}


def test_no_constraint_fields():
    assert parse_constraint_spec({}) is None
    assert parse_constraint_spec({"temperature": 0.2, "messages": []}) is None


def test_response_format_text_is_noop():
    assert parse_constraint_spec({"response_format": {"type": "text"}}) is None


def test_response_format_json_object():
    spec = parse_constraint_spec({"response_format": {"type": "json_object"}})
    assert spec is not None
    assert spec.kind == "json_schema"
    assert spec.payload == JSON_OBJECT_SCHEMA


def test_response_format_json_schema_openai_shape():
    body = {
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "thing", "schema": SCHEMA, "strict": True},
        }
    }
    spec = parse_constraint_spec(body)
    assert spec is not None
    assert spec.kind == "json_schema"
    assert json.loads(spec.payload) == SCHEMA


def test_response_format_json_schema_lenient_top_level_schema():
    spec = parse_constraint_spec(
        {"response_format": {"type": "json_schema", "schema": SCHEMA}}
    )
    assert spec is not None
    assert json.loads(spec.payload) == SCHEMA


def test_response_format_json_schema_missing_schema():
    with pytest.raises(ConstraintSpecError, match="json_schema"):
        parse_constraint_spec({"response_format": {"type": "json_schema"}})


def test_response_format_unknown_type():
    with pytest.raises(ConstraintSpecError, match="unsupported"):
        parse_constraint_spec({"response_format": {"type": "yaml"}})


def test_response_format_not_a_dict():
    with pytest.raises(ConstraintSpecError, match="must be an object"):
        parse_constraint_spec({"response_format": "json"})


def test_guided_json_dict_and_string_are_equivalent():
    a = parse_constraint_spec({"guided_json": SCHEMA})
    b = parse_constraint_spec({"guided_json": json.dumps(SCHEMA)})
    assert a == b
    assert a is not None and a.kind == "json_schema"


def test_guided_json_invalid_json_string():
    with pytest.raises(ConstraintSpecError, match="not valid JSON"):
        parse_constraint_spec({"guided_json": "{nope"})


def test_guided_json_boolean_schema_rejected():
    with pytest.raises(ConstraintSpecError, match="schema object"):
        parse_constraint_spec({"guided_json": True})


def test_guided_regex():
    spec = parse_constraint_spec({"guided_regex": "[0-9]+"})
    assert spec is not None
    assert spec.kind == "regex"
    assert spec.payload == "[0-9]+"


def test_guided_regex_empty_rejected():
    with pytest.raises(ConstraintSpecError, match="guided_regex"):
        parse_constraint_spec({"guided_regex": ""})


def test_guided_choice():
    spec = parse_constraint_spec({"guided_choice": ["yes", "no", 3]})
    assert spec is not None
    assert spec.kind == "choice"
    assert spec.choices() == ["yes", "no", "3"]


def test_guided_choice_rejects_empty_and_non_strings():
    with pytest.raises(ConstraintSpecError):
        parse_constraint_spec({"guided_choice": []})
    with pytest.raises(ConstraintSpecError):
        parse_constraint_spec({"guided_choice": [{"a": 1}]})
    with pytest.raises(ConstraintSpecError):
        parse_constraint_spec({"guided_choice": [""]})


def test_conflicting_constraints_rejected():
    with pytest.raises(ConstraintSpecError, match="conflicting"):
        parse_constraint_spec(
            {"guided_regex": "a+", "response_format": {"type": "json_object"}}
        )


def test_text_response_format_does_not_conflict():
    spec = parse_constraint_spec(
        {"response_format": {"type": "text"}, "guided_regex": "a+"}
    )
    assert spec is not None and spec.kind == "regex"


def test_cache_key_is_canonical():
    a = parse_constraint_spec({"guided_json": {"type": "object", "properties": {}}})
    b = parse_constraint_spec({"guided_json": '{"properties": {}, "type": "object"}'})
    assert a is not None and b is not None
    assert a.cache_key == b.cache_key


def test_choices_to_regex_escapes_metacharacters():
    regex = choices_to_regex(["a.b", "c|d"])
    assert regex == r"(a\.b|c\|d)"
