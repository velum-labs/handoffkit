from __future__ import annotations

import hashlib
from pathlib import Path

from fusionkit_core.contracts import ArtifactKind, ContractArtifactRef

_MAX_SUFFIX_BODY_LENGTH = 16


def hash_bytes(content: bytes) -> str:
    return "sha256:" + hashlib.sha256(content).hexdigest()


def hash_text(content: str) -> str:
    return hash_bytes(content.encode("utf-8"))


def _path_component(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _validate_suffix(suffix: str) -> None:
    body = suffix[1:] if suffix.startswith(".") else ""
    if (
        not body
        or len(body) > _MAX_SUFFIX_BODY_LENGTH
        or not body.isascii()
        or not body.isalnum()
    ):
        raise ValueError("artifact suffix must be a dot followed by 1-16 ASCII letters or digits")


class LocalArtifactStore:
    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def write_text(
        self,
        run_id: str,
        artifact_id: str,
        kind: ArtifactKind,
        content: str,
        *,
        suffix: str = ".txt",
    ) -> ContractArtifactRef:
        _validate_suffix(suffix)
        artifact_dir = self.root / _path_component(run_id) / "artifacts"
        artifact_dir.mkdir(parents=True, exist_ok=True)
        path = artifact_dir / f"{_path_component(artifact_id)}{suffix}"
        path.write_text(content, encoding="utf-8")
        return ContractArtifactRef(
            artifact_id=artifact_id,
            kind=kind,
            uri=str(path),
            hash=hash_text(content),
            redaction_status="synthetic",
        )


__all__ = [
    "LocalArtifactStore",
    "hash_bytes",
    "hash_text",
]
