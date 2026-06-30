from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

CONTRACT_ROOT = Path(__file__).resolve().parents[1] / "spec" / "model-fusion-contract"
SCHEMA_DIR = CONTRACT_ROOT / "schema"
FIXTURE_DIR = CONTRACT_ROOT / "fixture"

FORBIDDEN_SECRET_PATTERNS = [
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bsk-[A-Za-z0-9]{20,}\b"),
]


@dataclass(frozen=True)
class ValidationSummary:
    schema_bundle_hash: str
    schema_count: int
    fixture_count: int
    fixture_counts: Mapping[str, int]


def compute_schema_bundle_hash(schema_dir: Path = SCHEMA_DIR) -> str:
    payload = []
    for path in sorted(schema_dir.glob("*.schema.json")):
        payload.append(
            {
                "path": path.name,
                "schema": _load_json(path),
            }
        )
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def validate_contract_fixtures(
    schema_dir: Path = SCHEMA_DIR,
    fixture_dir: Path = FIXTURE_DIR,
) -> ValidationSummary:
    schema_documents = _load_schema_documents(schema_dir)
    _validate_schema_ids(schema_documents)
    registry = _build_registry(schema_documents)
    schema_by_name = _schema_by_name(schema_documents)
    expected_bundle_hash = compute_schema_bundle_hash(schema_dir)

    _validate_schema_documents(schema_documents, registry)
    _validate_fixture_pairs(schema_by_name, fixture_dir)

    fixture_counts: Counter[str] = Counter()
    fixture_count = 0
    for fixture_path in sorted(fixture_dir.glob("*/*.json")):
        fixture = _load_json(fixture_path)
        _check_forbidden_secret_content(fixture_path, fixture)
        schema_name = fixture.get("schema")
        if not isinstance(schema_name, str):
            raise ValueError(f"{fixture_path}: fixture must contain string field 'schema'")
        schema = schema_by_name.get(schema_name)
        if schema is None:
            raise ValueError(f"{fixture_path}: unknown fixture schema {schema_name!r}")
        actual_bundle_hash = fixture.get("schema_bundle_hash")
        if actual_bundle_hash != expected_bundle_hash:
            raise ValueError(
                f"{fixture_path}: schema_bundle_hash {actual_bundle_hash!r} does not match "
                f"{expected_bundle_hash!r}"
            )
        _validate_fixture(fixture_path, fixture, schema, registry)
        fixture_counts[schema_name] += 1
        fixture_count += 1

    return ValidationSummary(
        schema_bundle_hash=expected_bundle_hash,
        schema_count=len(schema_by_name),
        fixture_count=fixture_count,
        fixture_counts=dict(sorted(fixture_counts.items())),
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate model fusion contract fixtures.")
    parser.add_argument(
        "--print-bundle-hash",
        action="store_true",
        help="Print the deterministic hash of schema/*.schema.json before validating.",
    )
    args = parser.parse_args()

    if args.print_bundle_hash:
        print(compute_schema_bundle_hash())

    summary = validate_contract_fixtures()
    print(
        json.dumps(
            {
                "schema_bundle_hash": summary.schema_bundle_hash,
                "schemas": summary.schema_count,
                "fixtures": summary.fixture_count,
                "fixture_counts": summary.fixture_counts,
            },
            sort_keys=True,
        )
    )


def _load_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def _load_schema_documents(schema_dir: Path) -> list[dict[str, Any]]:
    documents = []
    for path in sorted(schema_dir.glob("*.schema.json")):
        document = _load_json(path)
        if not isinstance(document, dict):
            raise ValueError(f"{path}: schema document must be an object")
        documents.append(document)
    if not documents:
        raise ValueError(f"No schema files found under {schema_dir}")
    return documents


def _validate_schema_ids(schema_documents: list[dict[str, Any]]) -> None:
    ids = []
    for schema in schema_documents:
        schema_id = schema.get("$id")
        if not isinstance(schema_id, str) or not schema_id:
            raise ValueError(f"Schema {schema.get('title', '<unknown>')} is missing a stable $id")
        ids.append(schema_id)

    duplicates = sorted(id_ for id_, count in Counter(ids).items() if count > 1)
    if duplicates:
        raise ValueError(f"Duplicate schema $id values: {duplicates}")


def _build_registry(schema_documents: list[dict[str, Any]]) -> Registry:
    resources = [
        (schema["$id"], Resource.from_contents(schema, default_specification=DRAFT202012))
        for schema in schema_documents
    ]
    return Registry().with_resources(resources)


def _schema_by_name(schema_documents: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    schema_by_name = {}
    for schema in schema_documents:
        title = schema.get("title")
        if title == "Model Fusion Contract Common Definitions":
            continue
        if not isinstance(title, str) or not title:
            raise ValueError(f"Schema {schema.get('$id', '<unknown>')} is missing a record title")
        schema_by_name[title] = schema
    return schema_by_name


def _validate_schema_documents(
    schema_documents: list[dict[str, Any]],
    registry: Registry,
) -> None:
    for schema in schema_documents:
        Draft202012Validator.check_schema(schema)
        Draft202012Validator(schema, registry=registry)


def _validate_fixture_pairs(
    schema_by_name: Mapping[str, dict[str, Any]],
    fixture_dir: Path,
) -> None:
    missing = []
    for schema_name in sorted(schema_by_name):
        schema_fixture_dir = fixture_dir / schema_name
        for fixture_name in ("minimal.json", "realistic.json"):
            fixture_path = schema_fixture_dir / fixture_name
            if not fixture_path.exists():
                missing.append(str(fixture_path))
    if missing:
        raise ValueError("Missing required fixture files: " + ", ".join(missing))


def _validate_fixture(
    fixture_path: Path,
    fixture: Mapping[str, Any],
    schema: Mapping[str, Any],
    registry: Registry,
) -> None:
    validator = Draft202012Validator(
        schema,
        registry=registry,
        format_checker=Draft202012Validator.FORMAT_CHECKER,
    )
    errors = sorted(validator.iter_errors(fixture), key=lambda error: error.json_path)
    if errors:
        messages = [f"{error.json_path}: {error.message}" for error in errors]
        raise ValueError(f"{fixture_path}: fixture validation failed: {'; '.join(messages)}")


def _check_forbidden_secret_content(path: Path, value: Any) -> None:
    for string_value in _iter_strings(value):
        for pattern in FORBIDDEN_SECRET_PATTERNS:
            if pattern.search(string_value):
                raise ValueError(f"{path}: fixture contains forbidden secret-shaped content")


def _iter_strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        strings = []
        for item in value:
            strings.extend(_iter_strings(item))
        return strings
    if isinstance(value, dict):
        strings = []
        for key, item in value.items():
            strings.append(str(key))
            strings.extend(_iter_strings(item))
        return strings
    return []


if __name__ == "__main__":
    main()
