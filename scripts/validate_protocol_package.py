from __future__ import annotations

import argparse
import json
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from validate_contract_fixtures import compute_schema_bundle_hash

CONTRACT_ROOT = Path(__file__).resolve().parents[1] / "spec" / "model-fusion-contract"
PACKAGE_JSON = CONTRACT_ROOT / "package.json"
PROTOCOL_PACKAGE_JSON = CONTRACT_ROOT / "protocol-package.json"
OPENAPI_FILE = CONTRACT_ROOT / "openapi" / "model-fusion.v1.openapi.json"
PYTHON_PACKAGE = CONTRACT_ROOT / "python" / "pyproject.toml"
PYTHON_BUILD_SCRIPT = Path(__file__).resolve().parent / "build_protocol_python_package.py"
CODEGEN_SCRIPT = Path(__file__).resolve().parent / "generate_protocol_codegen.py"

REQUIRED_SERVICE_PATHS = {
    "HarnessExecutorService": ("/v1/harness/execute-coding-task",),
    "CursorHarnessService": ("/v1/cursor/normalize-run",),
    "MlxProviderService": (
        "/v1/mlx/model-endpoints/{endpoint_id}",
        "/v1/mlx/model-calls",
    ),
    "BenchmarkJoinService": ("/v1/benchmarks/join-execution",),
}
REQUIRED_SCHEMA_REFS = (
    "../schema/benchmark-task-record.v1.schema.json",
    "../schema/cursor-run-result.v1.schema.json",
    "../schema/harness-candidate-record.v1.schema.json",
    "../schema/harness-run-result.v1.schema.json",
    "../schema/model-call-record.v1.schema.json",
    "../schema/model-endpoint.v1.schema.json",
)
PRIVATE_PYTHON_INDEXES = ("Cloudsmith", "AWS CodeArtifact", "Gemfury")
REQUIRED_TS_CODEGEN_DEPS = (
    "ajv",
    "openapi-fetch",
    "openapi-typescript",
)


@dataclass(frozen=True)
class ProtocolPackageSummary:
    schema_bundle_hash: str
    package_name: str
    package_version: str
    python_package_name: str
    services: tuple[str, ...]
    paths: tuple[str, ...]


def validate_protocol_package(contract_root: Path = CONTRACT_ROOT) -> ProtocolPackageSummary:
    package_json = _load_json(contract_root / "package.json")
    protocol_package = _load_json(contract_root / "protocol-package.json")
    openapi = _load_json(contract_root / "openapi" / "model-fusion.v1.openapi.json")
    python_package = _load_toml(contract_root / "python" / "pyproject.toml")

    _validate_package_json(package_json)
    _validate_protocol_package_json(protocol_package, contract_root)
    _validate_python_package(python_package, protocol_package, package_json, openapi)
    services, paths = _validate_openapi(openapi, contract_root, package_json)
    _validate_generated_outputs(contract_root)
    _validate_no_v1_proto_requirements(contract_root)
    _require_file(PYTHON_BUILD_SCRIPT)
    _require_file(CODEGEN_SCRIPT)

    return ProtocolPackageSummary(
        schema_bundle_hash=protocol_package["schema_bundle_hash"],
        package_name=package_json["name"],
        package_version=package_json["version"],
        python_package_name=python_package["project"]["name"],
        services=tuple(service for service in REQUIRED_SERVICE_PATHS if service in services),
        paths=tuple(
            path
            for service_paths in REQUIRED_SERVICE_PATHS.values()
            for path in service_paths
            if path in paths
        ),
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate model-fusion protocol packaging.")
    parser.parse_args()
    summary = validate_protocol_package()
    print(
        json.dumps(
            {
                "schema_bundle_hash": summary.schema_bundle_hash,
                "package_name": summary.package_name,
                "package_version": summary.package_version,
                "python_package_name": summary.python_package_name,
                "services": list(summary.services),
                "paths": list(summary.paths),
            },
            sort_keys=True,
        )
    )


def _load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected a JSON object")
    return data


def _load_toml(path: Path) -> dict[str, Any]:
    with path.open("rb") as handle:
        data = tomllib.load(handle)
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected a TOML object")
    return data


def _require_file(path: Path) -> None:
    if not path.exists():
        raise ValueError(f"Missing protocol package file: {path}")


def _validate_package_json(package_json: dict[str, Any]) -> None:
    if package_json.get("name") != "@velum/model-fusion-protocol":
        raise ValueError("package.json must publish @velum/model-fusion-protocol")
    if package_json.get("version") != "0.1.0":
        raise ValueError("package.json version must match protocol package version")
    publish_config = package_json.get("publishConfig")
    if not isinstance(publish_config, dict):
        raise ValueError("package.json must include publishConfig")
    if publish_config.get("registry") != "https://npm.pkg.github.com":
        raise ValueError("package.json must target GitHub Packages for npm")
    files = package_json.get("files")
    if not isinstance(files, list):
        raise ValueError("package.json must include a files list")
    for required_file in ("schema", "openapi", "gen", "protocol-package.json"):
        if required_file not in files:
            raise ValueError(f"package.json files must include {required_file}")
    scripts = package_json.get("scripts")
    if not isinstance(scripts, dict):
        raise ValueError("package.json must include generation/validation scripts")
    if "validate:contracts" not in scripts:
        raise ValueError("package.json must expose validate:contracts")
    if "generate:typescript" not in scripts:
        raise ValueError("package.json must expose generate:typescript")
    if "generate:python" not in scripts:
        raise ValueError("package.json must expose generate:python")
    if "check:generated" not in scripts:
        raise ValueError("package.json must expose check:generated")
    dev_dependencies = package_json.get("devDependencies")
    if not isinstance(dev_dependencies, dict):
        raise ValueError("package.json must pin TypeScript generator dependencies")
    for dependency in REQUIRED_TS_CODEGEN_DEPS:
        if dependency not in dev_dependencies:
            raise ValueError(f"package.json must include {dependency}")


def _validate_protocol_package_json(
    protocol_package: dict[str, Any],
    contract_root: Path,
) -> None:
    expected_hash = compute_schema_bundle_hash(contract_root / "schema")
    if protocol_package.get("schema_bundle_hash") != expected_hash:
        raise ValueError("protocol-package.json schema_bundle_hash is out of date")
    if protocol_package.get("package_name") != "@velum/model-fusion-protocol":
        raise ValueError("protocol-package.json package_name is incorrect")
    if protocol_package.get("version") != "0.1.0":
        raise ValueError("protocol-package.json version is incorrect")
    if protocol_package.get("json_schema_format") != "persisted-record-audit-format":
        raise ValueError("protocol-package.json must keep JSON Schema as audit format")
    if protocol_package.get("v1_service_source_of_truth") != "openapi-3.1-http-json":
        raise ValueError("protocol-package.json must make OpenAPI 3.1 the v1 service source")
    openapi_config = protocol_package.get("openapi")
    if not isinstance(openapi_config, dict):
        raise ValueError("protocol-package.json must include OpenAPI config")
    if openapi_config.get("source") != "v1_http_json_source_of_truth":
        raise ValueError("OpenAPI must be the v1 HTTP/JSON source of truth")
    if openapi_config.get("path") != "openapi/model-fusion.v1.openapi.json":
        raise ValueError("OpenAPI package path is incorrect")
    if openapi_config.get("version") != "3.1.0":
        raise ValueError("OpenAPI package config must target 3.1.0")
    protobuf_config = protocol_package.get("protobuf")
    if not isinstance(protobuf_config, dict):
        raise ValueError("protocol-package.json must include protobuf future-use config")
    if protobuf_config.get("required_for_v1") is not False:
        raise ValueError("protobuf must not be required for the v1 service path")
    codegen_config = protocol_package.get("codegen")
    if not isinstance(codegen_config, dict):
        raise ValueError("protocol-package.json must include codegen config")
    if codegen_config.get("drift_check") != "npm run check:generated":
        raise ValueError("protocol-package.json must document generated drift check")
    for key in ("openapi_service_clients", "json_schema_record_validators"):
        paths = codegen_config.get(key)
        if not isinstance(paths, list) or not paths:
            raise ValueError(f"protocol-package.json codegen.{key} must list outputs")
        for output_path in paths:
            if not isinstance(output_path, str) or not (contract_root / output_path).exists():
                raise ValueError(f"Generated codegen output is missing: {output_path}")
    python_config = protocol_package.get("python")
    if not isinstance(python_config, dict):
        raise ValueError("protocol-package.json must include Python package config")
    indexes = python_config.get("preferred_private_indexes")
    if not isinstance(indexes, list):
        raise ValueError("Python package config must list private index options")
    for index in PRIVATE_PYTHON_INDEXES:
        if index not in indexes:
            raise ValueError(f"Python package config must include {index}")


def _validate_python_package(
    python_package: dict[str, Any],
    protocol_package: dict[str, Any],
    package_json: dict[str, Any],
    openapi: dict[str, Any],
) -> None:
    project = python_package.get("project")
    if not isinstance(project, dict):
        raise ValueError("Python protocol package must include [project]")
    python_config = protocol_package.get("python")
    if not isinstance(python_config, dict):
        raise ValueError("protocol-package.json must include Python package config")
    if project.get("name") != python_config.get("package"):
        raise ValueError("Python package name must match protocol-package.json")
    expected_version = package_json.get("version")
    if project.get("version") != expected_version:
        raise ValueError("Python package version must match npm package version")
    info = openapi.get("info")
    if not isinstance(info, dict) or info.get("version") != expected_version:
        raise ValueError("OpenAPI info.version must match package version")
    configured_assets = (
        python_package.get("tool", {})
        .get("velum", {})
        .get("protocol", {})
        .get("assets", {})
        .get("include")
    )
    if not isinstance(configured_assets, list):
        raise ValueError("Python package must declare staged protocol assets")
    for required_asset in ("schema", "openapi", "protocol-package.json"):
        if required_asset not in configured_assets:
            raise ValueError(f"Python package must include staged asset {required_asset}")


def _validate_openapi(
    openapi: dict[str, Any],
    contract_root: Path,
    package_json: dict[str, Any],
) -> tuple[set[str], set[str]]:
    if openapi.get("openapi") != "3.1.0":
        raise ValueError("OpenAPI contract must use version 3.1.0")
    info = openapi.get("info")
    if not isinstance(info, dict):
        raise ValueError("OpenAPI contract must include info")
    if info.get("version") != package_json.get("version"):
        raise ValueError("OpenAPI info.version must match package version")
    expected_hash = compute_schema_bundle_hash(contract_root / "schema")
    if info.get("x-schema-bundle-hash") != expected_hash:
        raise ValueError("OpenAPI schema bundle hash is out of date")
    paths = openapi.get("paths")
    if not isinstance(paths, dict):
        raise ValueError("OpenAPI contract must include paths")
    services = set()
    for service_tag, service_paths in REQUIRED_SERVICE_PATHS.items():
        for path in service_paths:
            path_item = paths.get(path)
            if not isinstance(path_item, dict):
                raise ValueError(f"OpenAPI contract missing path {path}")
            operations = [
                operation
                for operation in path_item.values()
                if isinstance(operation, dict) and "operationId" in operation
            ]
            if not operations:
                raise ValueError(f"OpenAPI path {path} must declare an operation")
            if not any(service_tag in operation.get("tags", []) for operation in operations):
                raise ValueError(f"OpenAPI path {path} must use tag {service_tag}")
            services.add(service_tag)
    encoded = json.dumps(openapi, sort_keys=True)
    for schema_ref in REQUIRED_SCHEMA_REFS:
        if schema_ref not in encoded:
            raise ValueError(f"OpenAPI contract must reference {schema_ref}")
    return services, set(paths)


def _validate_generated_outputs(contract_root: Path) -> None:
    required_outputs = (
        contract_root / "gen" / "typescript" / "openapi.d.ts",
        contract_root / "gen" / "typescript" / "client.ts",
        contract_root / "gen" / "typescript" / "record-validators.ts",
        contract_root
        / "python"
        / "src"
        / "velum_model_fusion_protocol"
        / "generated"
        / "__init__.py",
        contract_root
        / "python"
        / "src"
        / "velum_model_fusion_protocol"
        / "generated"
        / "openapi_client.py",
        contract_root
        / "python"
        / "src"
        / "velum_model_fusion_protocol"
        / "generated"
        / "record_validators.py",
    )
    missing = [str(path) for path in required_outputs if not path.exists()]
    if missing:
        raise ValueError("Generated protocol outputs are missing: " + ", ".join(missing))


def _validate_no_v1_proto_requirements(contract_root: Path) -> None:
    forbidden_paths = [
        contract_root / "buf.yaml",
        contract_root / "buf.gen.yaml",
        contract_root / "proto",
    ]
    existing = [str(path) for path in forbidden_paths if path.exists()]
    if existing:
        raise ValueError(
            "protobuf/Buf must not be part of the required v1 protocol path: "
            + ", ".join(existing)
        )


if __name__ == "__main__":
    main()
