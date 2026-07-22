from __future__ import annotations

import tomllib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
FORBIDDEN_RUNTIME_DEPENDENCIES = {
    "anthropic",
    "fusionkit-evals",
    "fusionkit-mlx",
    "google-genai",
    "hyperkit",
    "openai",
}


def _project(path: str) -> dict[str, object]:
    return tomllib.loads((REPO_ROOT / path).read_text(encoding="utf-8"))["project"]


def _dependency_names(project: dict[str, object]) -> set[str]:
    dependencies = project.get("dependencies", [])
    assert isinstance(dependencies, list)
    return {
        dependency.split("[", 1)[0].split("=", 1)[0].split("<", 1)[0].split(">", 1)[0]
        for dependency in dependencies
        if isinstance(dependency, str)
    }


def test_python_distribution_has_no_user_facing_fusionkit_binary_collision() -> None:
    project = _project("python/fusionkit-cli/pyproject.toml")
    assert project["scripts"] == {"fusionkit-sidecar": "fusionkit_cli.main:app"}


def test_python_runtime_has_no_provider_or_maintainer_dependencies() -> None:
    cli = _dependency_names(_project("python/fusionkit-cli/pyproject.toml"))
    core = _dependency_names(_project("python/fusionkit-core/pyproject.toml"))
    assert not FORBIDDEN_RUNTIME_DEPENDENCIES.intersection(cli | core)


def test_bench_app_and_dependencies_are_owned_only_by_evals() -> None:
    evals = _project("python/fusionkit-evals/pyproject.toml")
    assert evals["scripts"] == {"fusionkit-bench": "fusionkit_evals.cli:bench_app"}
    assert "fusionkit" not in _dependency_names(evals)
    commands = REPO_ROOT / "python/fusionkit-cli/src/fusionkit_cli/commands"
    assert not list(commands.glob("*.py"))
    assert (
        REPO_ROOT / "python/fusionkit-evals/src/fusionkit_evals/cli.py"
    ).is_file()
    implementations = [
        path.relative_to(REPO_ROOT).as_posix()
        for path in (REPO_ROOT / "python").rglob("*.py")
        if "bench_app = " + "typer.Typer(" in path.read_text(encoding="utf-8")
    ]
    assert implementations == [
        "python/fusionkit-evals/src/fusionkit_evals/cli.py"
    ]


def test_hyperkit_fusion_plugin_is_owned_by_maintainer_package() -> None:
    cli = _project("python/fusionkit-cli/pyproject.toml")
    evals = _project("python/fusionkit-evals/pyproject.toml")
    assert "entry-points" not in cli
    assert evals["entry-points"] == {
        "hyperkit.suts": {
            "fusionkit-serve": "fusionkit_evals.hyperkit_plugin:factory"
        }
    }


def test_provider_specific_runtime_modules_are_absent() -> None:
    source = REPO_ROOT / "python" / "fusionkit-core" / "src" / "fusionkit_core"
    forbidden = {
        "client_anthropic.py",
        "client_codex.py",
        "client_google.py",
        "client_openai.py",
        "credentials.py",
        "providers.py",
    }
    assert forbidden.isdisjoint(path.name for path in source.iterdir())
    assert sorted(path.name for path in source.glob("*client*.py")) == [
        "clients.py",
        "fake_client.py",
        "model_client.py",
        "routekit_client.py",
    ]


def test_runtime_source_has_no_provider_credentials_or_pricing_tables() -> None:
    roots = [
        REPO_ROOT / "python" / "fusionkit-core" / "src",
        REPO_ROOT / "python" / "fusionkit-server" / "src",
        REPO_ROOT / "python" / "fusionkit-cli" / "src",
    ]
    source = "\n".join(
        path.read_text(encoding="utf-8")
        for root in roots
        for path in root.rglob("*.py")
    ).lower()
    for forbidden in (
        "api_key_env",
        "subscriptionauth",
        "classify_provider_error",
        "client_anthropic",
        "client_codex",
        "client_google",
        "client_openai",
    ):
        assert forbidden not in source
    generated_registry = (
        REPO_ROOT
        / "python/fusionkit-core/src/fusionkit_core/_generated/fusion_registry_data.py"
    ).read_text(encoding="utf-8")
    assert "provider" not in generated_registry.lower()
    assert "pricing" not in generated_registry.lower()
    assert "apiKeyEnv" not in generated_registry
