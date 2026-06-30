"""Provenance capture so a benchmark result is reproducible and auditable.

Records the exact conditions of a run - repo SHA, package versions, platform,
prompt-template hash, model versions, dataset revision, seeds, timestamp - so a
number can be tied back to the code and data that produced it.
"""

from __future__ import annotations

import hashlib
import platform
from collections.abc import Mapping
from datetime import UTC, datetime
from importlib.metadata import PackageNotFoundError, version
from typing import Any

from fusionkit_core.contracts import producer_git_sha

_TRACKED_PACKAGES = ("fusionkit-core", "fusionkit-evals", "datasets", "pydantic")


def package_versions() -> dict[str, str]:
    versions: dict[str, str] = {}
    for name in _TRACKED_PACKAGES:
        try:
            versions[name] = version(name)
        except PackageNotFoundError:
            continue
    return versions


def hash_text(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def build_provenance(
    *,
    prompt_template: str | None = None,
    model_versions: Mapping[str, str] | None = None,
    dataset_revision: str | None = None,
    seeds: list[int] | None = None,
    extra: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    provenance: dict[str, Any] = {
        "generated_at": datetime.now(UTC).isoformat(),
        "repo_sha": producer_git_sha(),
        "python_version": platform.python_version(),
        "platform": platform.platform(),
        "package_versions": package_versions(),
        "model_versions": dict(model_versions or {}),
    }
    if prompt_template is not None:
        provenance["prompt_template_hash"] = hash_text(prompt_template)
    if dataset_revision is not None:
        provenance["dataset_revision"] = dataset_revision
    if seeds is not None:
        provenance["seeds"] = list(seeds)
    if extra:
        provenance.update(dict(extra))
    return provenance


__all__ = ["build_provenance", "hash_text", "package_versions"]
