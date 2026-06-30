from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path
from typing import Any, Literal

REPO_ROOT = Path(__file__).resolve().parents[1]
CONTRACT_ROOT = REPO_ROOT / "spec" / "model-fusion-contract"
SCHEMA_DIR = CONTRACT_ROOT / "schema"
OPENAPI_PATH = CONTRACT_ROOT / "openapi" / "model-fusion.v1.openapi.json"
TS_GEN_DIR = CONTRACT_ROOT / "gen" / "typescript"
PYTHON_GEN_DIR = (
    CONTRACT_ROOT
    / "python"
    / "src"
    / "velum_model_fusion_protocol"
    / "generated"
)
Language = Literal["typescript", "python", "all"]


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate model-fusion protocol SDK scaffolds.")
    parser.add_argument(
        "--language",
        choices=("typescript", "python", "all"),
        default="all",
    )
    args = parser.parse_args()

    if args.language in ("typescript", "all"):
        generate_typescript()
    if args.language in ("python", "all"):
        generate_python()


def generate_typescript() -> None:
    TS_GEN_DIR.mkdir(parents=True, exist_ok=True)
    schemas = _schema_records()
    openapi = _load_json(OPENAPI_PATH)
    (TS_GEN_DIR / "record-validators.ts").write_text(
        _typescript_record_validators(schemas),
        encoding="utf-8",
    )
    (TS_GEN_DIR / "client.ts").write_text(
        _typescript_client(openapi),
        encoding="utf-8",
    )
    (TS_GEN_DIR / "index.ts").write_text(
        _typescript_index(),
        encoding="utf-8",
    )


def generate_python() -> None:
    if PYTHON_GEN_DIR.exists():
        shutil.rmtree(PYTHON_GEN_DIR)
    PYTHON_GEN_DIR.mkdir(parents=True, exist_ok=True)
    schemas = _schema_records()
    openapi = _load_json(OPENAPI_PATH)
    (PYTHON_GEN_DIR / "__init__.py").write_text(
        _python_init(),
        encoding="utf-8",
    )
    (PYTHON_GEN_DIR / "record_validators.py").write_text(
        _python_record_validators(schemas),
        encoding="utf-8",
    )
    (PYTHON_GEN_DIR / "openapi_client.py").write_text(
        _python_openapi_client(openapi),
        encoding="utf-8",
    )


def _schema_records() -> list[dict[str, str]]:
    records = []
    for path in sorted(SCHEMA_DIR.glob("*.schema.json")):
        schema = _load_json(path)
        title = schema.get("title")
        if title == "Model Fusion Contract Common Definitions":
            continue
        if not isinstance(title, str):
            raise ValueError(f"{path}: missing schema title")
        records.append(
            {
                "name": title,
                "filename": path.name,
                "identifier": _identifier(title),
            }
        )
    return records


def _load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected JSON object")
    return data


def _typescript_record_validators(schemas: list[dict[str, str]]) -> str:
    imports = [
        f'import {record["identifier"]}Schema from "../../schema/{record["filename"]}" '
        'with { type: "json" };'
        for record in schemas
    ]
    schema_entries = [
        f'  "{record["name"]}": {record["identifier"]}Schema,'
        for record in schemas
    ]
    return "\n".join(
        [
            _generated_header("//"),
            'import Ajv from "ajv";',
            *imports,
            "",
            "export const recordSchemas = {",
            *schema_entries,
            "} as const;",
            "",
            "export type RecordSchemaName = keyof typeof recordSchemas;",
            "",
            "const ajv = new Ajv({ allErrors: true, strict: false });",
            "",
            "export const recordValidators = Object.fromEntries(",
            "  Object.entries(recordSchemas).map(([schemaName, schema]) => [",
            "    schemaName,",
            "    ajv.compile(schema),",
            "  ]),",
            ") as Record<RecordSchemaName, ReturnType<typeof ajv.compile>>;",
            "",
            "export function validateRecord(",
            "  schemaName: RecordSchemaName,",
            "  value: unknown,",
            "): boolean {",
            "  return recordValidators[schemaName](value) as boolean;",
            "}",
            "",
        ]
    )


def _typescript_client(openapi: dict[str, Any]) -> str:
    operation_ids = _operation_ids(openapi)
    operation_entries = [
        f'  "{operation_id}",'
        for operation_id in operation_ids
    ]
    return "\n".join(
        [
            _generated_header("//"),
            'import createClient from "openapi-fetch";',
            'import type { paths } from "./openapi";',
            "",
            "export type ModelFusionClient = ReturnType<typeof createClient<paths>>;",
            "",
            "export const operationIds = [",
            *operation_entries,
            "] as const;",
            "",
            "export type OperationId = (typeof operationIds)[number];",
            "",
            "export function createModelFusionClient(",
            "  ...args: Parameters<typeof createClient<paths>>",
            "): ModelFusionClient {",
            "  return createClient<paths>(...args);",
            "}",
            "",
        ]
    )


def _typescript_index() -> str:
    return "\n".join(
        [
            _generated_header("//"),
            'export * from "./client";',
            'export * from "./record-validators";',
            "",
        ]
    )


def _python_init() -> str:
    return "\n".join(
        [
            _generated_header("#"),
            "from velum_model_fusion_protocol.generated.openapi_client import (",
            "    OPERATION_PATHS,",
            "    SERVICE_PATHS,",
            "    ModelFusionOpenApiClient,",
            ")",
            "from velum_model_fusion_protocol.generated.record_validators import (",
            "    RECORD_SCHEMA_FILES,",
            "    validate_record,",
            ")",
            "",
            "__all__ = [",
            '    "ModelFusionOpenApiClient",',
            '    "OPERATION_PATHS",',
            '    "RECORD_SCHEMA_FILES",',
            '    "SERVICE_PATHS",',
            '    "validate_record",',
            "]",
            "",
        ]
    )


def _python_record_validators(schemas: list[dict[str, str]]) -> str:
    schema_entries = [
        f'    "{record["name"]}": "{record["filename"]}",'
        for record in schemas
    ]
    return "\n".join(
        [
            _generated_header("#"),
            "from __future__ import annotations",
            "",
            "import json",
            "from functools import cache",
            "from typing import Any",
            "",
            "from jsonschema import Draft202012Validator",
            "from referencing import Registry, Resource",
            "from referencing.jsonschema import DRAFT202012",
            "",
            "from velum_model_fusion_protocol import schema_dir",
            "",
            "RECORD_SCHEMA_FILES = {",
            *schema_entries,
            "}",
            "",
            "",
            "@cache",
            "def _schema_documents() -> dict[str, dict[str, Any]]:",
            "    documents = {}",
            "    for path in schema_dir().glob(\"*.schema.json\"):",
            "        with path.open(encoding=\"utf-8\") as handle:",
            "            document = json.load(handle)",
            "        documents[path.name] = document",
            "    return documents",
            "",
            "",
            "@cache",
            "def _registry() -> Registry:",
            "    resources = [",
            "        (",
            "            document[\"$id\"],",
            "            Resource.from_contents(document, default_specification=DRAFT202012),",
            "        )",
            "        for document in _schema_documents().values()",
            "    ]",
            "    return Registry().with_resources(resources)",
            "",
            "",
            "@cache",
            "def _validator(schema_name: str) -> Draft202012Validator:",
            "    schema_file = RECORD_SCHEMA_FILES[schema_name]",
            "    schema = _schema_documents()[schema_file]",
            "    return Draft202012Validator(",
            "        schema,",
            "        registry=_registry(),",
            "        format_checker=Draft202012Validator.FORMAT_CHECKER,",
            "    )",
            "",
            "",
            "def validate_record(schema_name: str, value: Any) -> None:",
            "    _validator(schema_name).validate(value)",
            "",
        ]
    )


def _python_openapi_client(openapi: dict[str, Any]) -> str:
    service_paths = _service_paths(openapi)
    operation_paths = _operation_paths(openapi)
    return "\n".join(
        [
            _generated_header("#"),
            "from __future__ import annotations",
            "",
            "import json",
            "import urllib.request",
            "from typing import Any",
            "",
            "SERVICE_PATHS = {",
            *_python_dict_list_entries(service_paths),
            "}",
            "",
            "OPERATION_PATHS = {",
            *_python_dict_tuple_entries(operation_paths),
            "}",
            "",
            "",
            "class ModelFusionOpenApiClient:",
            "    def __init__(self, base_url: str) -> None:",
            "        self.base_url = base_url.rstrip(\"/\")",
            "",
            "    def request_json(",
            "        self,",
            "        operation_id: str,",
            "        *,",
            "        body: dict[str, Any] | None = None,",
            "        path_params: dict[str, str] | None = None,",
            "        timeout_s: float = 30.0,",
            "    ) -> Any:",
            "        method, path = OPERATION_PATHS[operation_id]",
            "        for key, value in (path_params or {}).items():",
            "            path = path.replace(\"{\" + key + \"}\", value)",
            "        data = None if body is None else json.dumps(body).encode()",
            "        request = urllib.request.Request(",
            "            self.base_url + path,",
            "            data=data,",
            "            method=method.upper(),",
            "            headers={\"Content-Type\": \"application/json\"},",
            "        )",
            "        with urllib.request.urlopen(request, timeout=timeout_s) as response:",
            "            return json.loads(response.read().decode())",
            "",
        ]
    )


def _service_paths(openapi: dict[str, Any]) -> dict[str, list[str]]:
    service_paths: dict[str, list[str]] = {}
    for path, _method, operation in _iter_operations(openapi):
        for tag in operation.get("tags", []):
            service_paths.setdefault(tag, []).append(path)
    return {key: sorted(value) for key, value in sorted(service_paths.items())}


def _operation_paths(openapi: dict[str, Any]) -> dict[str, tuple[str, str]]:
    operations = {}
    for path, method, operation in _iter_operations(openapi):
        operation_id = operation.get("operationId")
        if isinstance(operation_id, str):
            operations[operation_id] = (method, path)
    return dict(sorted(operations.items()))


def _operation_ids(openapi: dict[str, Any]) -> list[str]:
    return sorted(_operation_paths(openapi))


def _iter_operations(openapi: dict[str, Any]) -> list[tuple[str, str, dict[str, Any]]]:
    operations = []
    paths = openapi.get("paths")
    if not isinstance(paths, dict):
        return operations
    for path, path_item in paths.items():
        if not isinstance(path_item, dict):
            continue
        for method, operation in path_item.items():
            if isinstance(operation, dict) and isinstance(operation.get("operationId"), str):
                operations.append((str(path), str(method), operation))
    return operations


def _identifier(name: str) -> str:
    return "".join(part.capitalize() for part in name.replace("_", "-").split("-")).replace(".", "")


def _python_dict_list_entries(value: dict[str, list[str]]) -> list[str]:
    return [
        f"    {key!r}: {items!r},"
        for key, items in sorted(value.items())
    ]


def _python_dict_tuple_entries(value: dict[str, tuple[str, str]]) -> list[str]:
    return [
        f"    {key!r}: {items!r},"
        for key, items in sorted(value.items())
    ]


def _generated_header(prefix: str) -> str:
    return f"{prefix} Generated by scripts/generate_protocol_codegen.py; do not edit."


if __name__ == "__main__":
    main()
