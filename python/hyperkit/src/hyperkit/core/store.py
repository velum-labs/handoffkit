"""ShardResult store: the durable checkpoint that makes sweeps resumable.

A shard whose result is present is done -- resume submits only the absent ones.
The local store is a directory of JSON files keyed by shard_id; the same
interface is what an S3-backed store implements for the cloud backend.
"""

from __future__ import annotations

from pathlib import Path

from hyperkit.core.models import ShardResult


class ResultStore:
    """Filesystem result store: ``<root>/<sweep_id>/<shard_id>.json``."""

    def __init__(self, root: Path):
        self.root = Path(root)

    def _dir(self, sweep_id: str) -> Path:
        return self.root / sweep_id

    def has(self, sweep_id: str, shard_id: str) -> bool:
        return (self._dir(sweep_id) / f"{shard_id}.json").exists()

    def put(self, sweep_id: str, result: ShardResult) -> None:
        d = self._dir(sweep_id)
        d.mkdir(parents=True, exist_ok=True)
        path = d / f"{result.shard_id}.json"
        payload = result.model_dump_json(indent=2)
        try:
            with path.open("x") as stream:
                stream.write(payload)
        except FileExistsError:
            existing = ShardResult.model_validate_json(path.read_text())
            if existing != result:
                raise ValueError(
                    f"conflicting immutable result for shard {result.shard_id}"
                ) from None

    def get_all(self, sweep_id: str) -> list[ShardResult]:
        d = self._dir(sweep_id)
        if not d.exists():
            return []
        out: list[ShardResult] = []
        for path in sorted(d.glob("*.json")):
            out.append(ShardResult.model_validate_json(path.read_text()))
        return out

    def present_ids(self, sweep_id: str) -> set[str]:
        d = self._dir(sweep_id)
        if not d.exists():
            return set()
        return {p.stem for p in d.glob("*.json")}
