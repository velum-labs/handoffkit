import importlib
import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType


def test_protocol_package_metadata_and_idl_are_drift_checked() -> None:
    module = _load_validator_module()

    summary = module.validate_protocol_package()

    assert summary.schema_bundle_hash == (
        "sha256:75792f89c091b6ab4fd317a15fb03fd73438563dceff5ccf9f5d7c752dbf35f3"
    )
    assert summary.package_name == "@velum-labs/model-fusion-protocol"
    assert summary.package_version == "0.1.0"
    assert summary.python_package_name == "velum-model-fusion-protocol"
    assert summary.services == (
        "HarnessExecutorService",
        "CursorHarnessService",
        "MlxProviderService",
        "BenchmarkJoinService",
    )
    assert summary.paths == (
        "/v1/harness/execute-coding-task",
        "/v1/cursor/normalize-run",
        "/v1/mlx/model-endpoints/{endpoint_id}",
        "/v1/mlx/model-calls",
        "/v1/benchmarks/join-execution",
    )


def test_generated_python_record_validator_accepts_fixture() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    protocol_src = (
        repo_root
        / "spec"
        / "model-fusion-contract"
        / "python"
        / "src"
    )
    if str(protocol_src) not in sys.path:
        sys.path.insert(0, str(protocol_src))

    generated = importlib.import_module("velum_model_fusion_protocol.generated")

    fixture_path = (
        repo_root
        / "spec"
        / "model-fusion-contract"
        / "fixture"
        / "harness-run-result.v1"
        / "minimal.json"
    )
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))

    generated.validate_record("harness-run-result.v1", fixture)


def _load_validator_module() -> ModuleType:
    repo_root = Path(__file__).resolve().parents[1]
    scripts_dir = repo_root / "scripts"
    module_path = scripts_dir / "validate_protocol_package.py"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    spec = importlib.util.spec_from_file_location("validate_protocol_package", module_path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module
