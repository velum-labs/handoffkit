"""One-shot migration of persisted fusion run data to the trajectory contract.

The trajectory-fusion unification is a hard cutover: events and records that used
the ``candidate`` vocabulary (``candidate_recorded`` events, ``candidate_ids`` /
``selected_candidate_id`` on fusion records, ``input_candidate_ids`` /
``selected_candidate_id`` on judge-synthesis records, the ``select_candidate``
decision, and the ``harness-trajectory.v1`` schema name) no longer validate under
``extra="forbid"``. This rewrites existing ``.fusionkit`` run directories
(events.jsonl + summary.json) in place so they replay cleanly.

Usage:
    uv run python scripts/migrate_runs_to_trajectory.py [ROOT ...]

Defaults to ``.fusionkit`` under the current working directory.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

OLD_BUNDLE_HASH = "sha256:955da2d6891c88d4c40746a8206439e2dae2efc1e7ffefca015e84d4ce265671"
NEW_BUNDLE_HASH = "sha256:aae33b89a771fd5916e21bfffc5993d2d7ef98ecfc8542ba9570a8c99074d541"

_KEY_RENAMES = {
    "candidate_id": "trajectory_id",
    "source_candidate_id": "source_trajectory_id",
    "candidate_ids": "trajectory_ids",
    "selected_candidate_id": "selected_trajectory_id",
    "input_candidate_ids": "input_trajectory_ids",
    "resumed_candidate_id": "resumed_trajectory_id",
    "candidate_count": "trajectory_count",
    "candidate_model_ids": "trajectory_model_ids",
    "candidate_contributions": "trajectory_contributions",
    "candidate_rejections": "trajectory_rejections",
    "candidate_ranks": "trajectory_ranks",
}
_VALUE_RENAMES = {
    "harness-trajectory.v1": "trajectory.v1",
    "select_candidate": "select_trajectory",
    "candidate_recorded": "trajectory_recorded",
    OLD_BUNDLE_HASH: NEW_BUNDLE_HASH,
}


def _migrate(value: Any) -> Any:
    if isinstance(value, dict):
        migrated: dict[str, Any] = {}
        for key, item in value.items():
            new_key = str(_KEY_RENAMES.get(key, key))
            # The candidate_recorded event nested its payload under "candidate".
            if key == "candidate" and isinstance(item, dict):
                new_key = "trajectory"
            migrated[new_key] = _migrate(item)
        return migrated
    if isinstance(value, list):
        return [_migrate(item) for item in value]
    if isinstance(value, str):
        return _VALUE_RENAMES.get(value, value)
    return value


def _migrate_jsonl(path: Path) -> bool:
    lines = path.read_text(encoding="utf-8").splitlines()
    out = []
    changed = False
    for line in lines:
        if not line.strip():
            out.append(line)
            continue
        record = json.loads(line)
        migrated = _migrate(record)
        new_line = json.dumps(migrated)
        out.append(new_line)
        changed = changed or new_line != line
    if changed:
        path.write_text("\n".join(out) + "\n", encoding="utf-8")
    return changed


def _migrate_json(path: Path) -> bool:
    original = path.read_text(encoding="utf-8")
    migrated = _migrate(json.loads(original))
    new_text = json.dumps(migrated, indent=2) + "\n"
    if new_text != original:
        path.write_text(new_text, encoding="utf-8")
        return True
    return False


def main(roots: list[str]) -> None:
    targets = [Path(root) for root in roots] or [Path(".fusionkit")]
    migrated_files = 0
    for root in targets:
        if not root.exists():
            continue
        for path in root.rglob("events.jsonl"):
            if _migrate_jsonl(path):
                migrated_files += 1
                print(f"migrated {path}")
        for path in root.rglob("summary.json"):
            if _migrate_json(path):
                migrated_files += 1
                print(f"migrated {path}")
    print(f"done: {migrated_files} files migrated")


if __name__ == "__main__":
    main(sys.argv[1:])
