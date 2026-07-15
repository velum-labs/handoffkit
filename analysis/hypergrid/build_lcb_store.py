"""Build the local LiveCodeBench problem store for the hyperkit adapter.

Reads the raw HF jsonl shards (test.jsonl .. test6.jsonl) and writes one
``<question_id>.json`` per manifest instance into ``HYPERKIT_LCB_DIR``
(default ``~/.cache/hyperkit/livecodebench``). Zero API spend; idempotent.

Usage: uv run python analysis/hypergrid/build_lcb_store.py --jsonl-dir /tmp/lcb
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

from hyperkit.adapters.livecodebench import _legacy_fixture_json

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


def _normalize_fixtures(value: object, *, private: bool) -> str:
    if not isinstance(value, str):
        raise ValueError("LiveCodeBench fixtures must be encoded as strings")
    try:
        decoded = json.loads(value)
    except json.JSONDecodeError:
        if not private:
            raise
        decoded = _legacy_fixture_json(value)
    if not isinstance(decoded, list):
        raise ValueError("LiveCodeBench fixtures must decode to a list")
    return json.dumps(decoded, sort_keys=True, separators=(",", ":"))


def _content_sha256(row: dict[str, object]) -> str:
    canonical = json.dumps(row, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


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
    remaining = set(ids)
    print(f"manifest instances: {len(ids)}")

    written = 0
    unchanged = 0
    for name in JSONL_NAMES:
        path = args.jsonl_dir / name
        if not path.exists():
            continue
        with path.open(encoding="utf-8") as handle:
            for line in handle:
                if not remaining:
                    break
                row = json.loads(line)
                qid = str(row.get("question_id"))
                if qid not in remaining:
                    continue
                slim = {k: row.get(k) for k in KEEP_FIELDS}
                slim["public_test_cases"] = _normalize_fixtures(
                    slim["public_test_cases"], private=False
                )
                slim["private_test_cases"] = _normalize_fixtures(
                    slim["private_test_cases"], private=True
                )
                slim["content_sha256"] = _content_sha256(slim)
                encoded = json.dumps(slim, sort_keys=True, separators=(",", ":"))
                destination = args.out / f"{qid}.json"
                if destination.exists() and destination.read_text(encoding="utf-8") == encoded:
                    unchanged += 1
                else:
                    tmp = destination.with_suffix(".tmp")
                    tmp.write_text(encoded, encoding="utf-8")
                    tmp.replace(destination)
                    written += 1
                remaining.discard(qid)
    print(
        f"wrote {written}; unchanged: {unchanged}; "
        f"still missing: {sorted(remaining)[:5] if remaining else 'none'}"
    )
    return 0 if not remaining else 1


if __name__ == "__main__":
    raise SystemExit(main())
