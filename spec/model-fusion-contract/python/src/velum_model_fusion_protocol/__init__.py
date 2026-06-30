from __future__ import annotations

from importlib.resources import files
from pathlib import Path

__version__ = "0.1.1"
SCHEMA_BUNDLE_HASH = "sha256:bb04c698793875568976fd6e5c7c9f76dd10f306c2ff2156be46b63afc261867"


def package_root() -> Path:
    return Path(str(files(__name__)))


def schema_dir() -> Path:
    bundled_schema_dir = package_root() / "schema"
    if bundled_schema_dir.exists():
        return bundled_schema_dir
    for parent in package_root().parents:
        schema_path = parent / "schema"
        if schema_path.exists():
            return schema_path
    return bundled_schema_dir


def openapi_dir() -> Path:
    bundled_openapi_dir = package_root() / "openapi"
    if bundled_openapi_dir.exists():
        return bundled_openapi_dir
    for parent in package_root().parents:
        openapi_path = parent / "openapi"
        if openapi_path.exists():
            return openapi_path
    return bundled_openapi_dir


def openapi_path() -> Path:
    return openapi_dir() / "model-fusion.v1.openapi.json"


__all__ = [
    "SCHEMA_BUNDLE_HASH",
    "__version__",
    "openapi_dir",
    "openapi_path",
    "package_root",
    "schema_dir",
]
