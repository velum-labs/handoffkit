"""Build the local LiveCodeBench problem store for the hyperkit adapter.

Reads the raw HF jsonl shards (test.jsonl .. test6.jsonl) and writes one
``<question_id>.json`` per manifest instance into ``HYPERKIT_LCB_DIR``
(default ``~/.cache/hyperkit/livecodebench``). Zero API spend; idempotent.

Usage: uv run python analysis/hypergrid/build_lcb_store.py --jsonl-dir /tmp/lcb
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
MANIFESTS = [HERE / "manifests" / name for name in ("dev.txt", "holdout.txt", "spare.txt")]
JSONL_NAMES = [f"test{n}.jsonl" for n in ("", "2", "3", "4", "5", "6")]
KEEP_FIELDS = (
    "question_id",
    "question_content",
    "difficulty",
    "contest_date",
    "platform",
    "public_test_cases",
    "private_test_cases",
)


def wanted_ids() -> set[str]:
    ids: set[str] = set()
    for manifest in MANIFESTS:
        for line in manifest.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                ids.add(line)
    return ids


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--jsonl-dir", type=Path, default=Path("/tmp/lcb"))
    parser.add_argument(
        "--out",
        type=Path,
        default=Path(
            os.environ.get(
                "HYPERKIT_LCB_DIR", str(Path.home() / ".cache" / "hyperkit" / "livecodebench")
            )
        ),
    )
    args = parser.parse_args()

    ids = wanted_ids()
    args.out.mkdir(parents=True, exist_ok=True)
    existing = {p.stem for p in args.out.glob("*.json")}
    missing = ids - existing
    print(f"manifest instances: {len(ids)}; already stored: {len(ids & existing)}")
    if not missing:
        print("store complete")
        return 0

    written = 0
    for name in JSONL_NAMES:
        path = args.jsonl_dir / name
        if not path.exists():
            continue
        with path.open(encoding="utf-8") as handle:
            for line in handle:
                if not missing:
                    break
                row = json.loads(line)
                qid = str(row.get("question_id"))
                if qid not in missing:
                    continue
                slim = {k: row.get(k) for k in KEEP_FIELDS}
                (args.out / f"{qid}.json").write_text(json.dumps(slim), encoding="utf-8")
                missing.discard(qid)
                written += 1
    print(f"wrote {written}; still missing: {sorted(missing)[:5] if missing else 'none'}")
    return 0 if not missing else 1


if __name__ == "__main__":
    raise SystemExit(main())
