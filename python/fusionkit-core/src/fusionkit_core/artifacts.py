from __future__ import annotations

import hashlib
from pathlib import Path

from fusionkit_core.contracts import ArtifactKind, ContractArtifactRef


def hash_bytes(content: bytes) -> str:
    return "sha256:" + hashlib.sha256(content).hexdigest()


def hash_text(content: str) -> str:
    return hash_bytes(content.encode("utf-8"))


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
        artifact_dir = self.root / run_id / "artifacts"
        artifact_dir.mkdir(parents=True, exist_ok=True)
        path = artifact_dir / f"{artifact_id}{suffix}"
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
