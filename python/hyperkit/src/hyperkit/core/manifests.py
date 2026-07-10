"""Built-in ManifestSource implementations."""

from __future__ import annotations

from pathlib import Path

from hyperkit.core.ids import hash_ids


class TextManifest:
    """Instance ids from a text file (``#`` comments ignored) + dataset hash."""

    def __init__(self, ref: str):
        self.ref = ref
        self._ids: list[str] = []
        if ref:
            path = Path(ref)
            if path.exists():
                self._ids = [
                    line.strip()
                    for line in path.read_text().splitlines()
                    if line.strip() and not line.startswith("#")
                ]

    def enumerate(self) -> list[str]:
        return list(self._ids)

    @property
    def dataset_hash(self) -> str:
        return hash_ids(self._ids)

