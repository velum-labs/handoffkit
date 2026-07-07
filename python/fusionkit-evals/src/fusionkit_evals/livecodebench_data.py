"""LiveCodeBench dataset loading and test decoding (importable).

Factored out of the runner adapter so both the adapter and the tuning
candidate-bank builder load problems and decode tests identically. The
``datasets`` dependency is imported lazily (install with ``datasets<4``).

Dataset rows are streamed (not materialized wholesale) so ``--subset`` and
frozen manifests stay memory-safe on constrained hosts.
"""

from __future__ import annotations

import base64
import contextlib
import hashlib
import heapq
import json
import pickle
import sys
import zlib
from collections.abc import Iterable, Iterator, Mapping, Sequence
from pathlib import Path
from typing import Any

LCB_PROMPT_SUFFIX = (
    "\n\nWrite a complete Python 3 program that reads from standard input and writes the "
    "answer to standard output. Respond with ONLY a single Python code block."
)


def _log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def load_manifest(manifest_path: str | Path | None) -> dict[str, Any] | None:
    if not manifest_path:
        return None
    return json.loads(Path(manifest_path).read_text(encoding="utf-8"))


def _open_lcb_stream(*, version: str) -> Iterable[dict[str, Any]]:
    # Imported lazily (runtime-only optional dep); install with `datasets<4`.
    from datasets import load_dataset  # pyright: ignore[reportMissingImports]

    _log(f"streaming livecodebench/code_generation_lite {version} (datasets<4) ...")
    return load_dataset(
        "livecodebench/code_generation_lite",
        split="test",
        version_tag=version,
        trust_remote_code=True,
        streaming=True,
    )


def _row_matches_filters(
    row: Mapping[str, Any],
    *,
    min_date: str,
    difficulties: set[str],
) -> bool:
    if (row.get("difficulty") or "").lower() not in difficulties:
        return False
    if str(row.get("contest_date") or "") < min_date:
        return False
    try:
        public = json.loads(row["public_test_cases"])
    except (KeyError, json.JSONDecodeError, TypeError):
        return False
    if any(tc.get("testtype") != "stdin" for tc in public):
        return False
    if row.get("starter_code"):
        return False
    return True


def load_problems(
    subset: int,
    *,
    version: str = "release_v6",
    min_date: str = "2025-01-01",
    difficulties: set[str] | None = None,
    manifest: Mapping[str, Any] | None = None,
) -> list[dict[str, Any]]:
    resolved_version = (manifest or {}).get("version") or version
    ds = _open_lcb_stream(version=resolved_version)
    resolved_difficulties = difficulties or {"medium", "hard"}
    if manifest is not None:
        chosen = _select_from_manifest(ds, manifest)
        if subset > 0:
            return chosen[:subset]
        return chosen
    return _select_recent(
        ds,
        subset,
        min_date=min_date,
        difficulties=resolved_difficulties,
    )


def _select_from_manifest(ds: Iterable[dict[str, Any]], manifest: Mapping[str, Any]) -> list[dict[str, Any]]:
    wanted = list(manifest.get("question_ids") or [])
    wanted_set = set(wanted)
    by_id: dict[str, dict[str, Any]] = {}
    for row in ds:
        qid = str(row.get("question_id"))
        if qid not in wanted_set:
            continue
        by_id[qid] = dict(row)
        if len(by_id) >= len(wanted_set):
            break
    chosen = [by_id[qid] for qid in wanted if qid in by_id]
    missing = [qid for qid in wanted if qid not in by_id]
    if missing:
        _log(f"manifest: {len(missing)} question_ids not found: {missing[:5]}")
    _log(f"selected {len(chosen)} problems from frozen manifest")
    return chosen


def _select_recent(
    ds: Iterable[dict[str, Any]],
    subset: int,
    *,
    min_date: str,
    difficulties: set[str],
) -> list[dict[str, Any]]:
    # Min-heap of (contest_date, row) capped at `subset` keeps only the newest matches.
    heap: list[tuple[str, dict[str, Any]]] = []
    for row in ds:
        if not _row_matches_filters(row, min_date=min_date, difficulties=difficulties):
            continue
        contest_date = str(row.get("contest_date") or "")
        qid = str(row.get("question_id"))
        item = (contest_date, qid, dict(row))
        if len(heap) < subset:
            heapq.heappush(heap, item)
        elif (contest_date, qid) > (heap[0][0], heap[0][1]):
            heapq.heapreplace(heap, item)
    chosen = [row for _, _, row in sorted(heap, key=lambda pair: (pair[0], pair[1]), reverse=True)]
    _log(f"selected {len(chosen)} problems (difficulty={sorted(difficulties)}, >= {min_date})")
    return chosen


def scan_matching_question_ids(
    count: int,
    *,
    version: str = "release_v6",
    min_date: str = "2025-01-01",
    difficulties: set[str] | None = None,
) -> list[dict[str, Any]]:
    """Stream the dataset and return metadata for the newest `count` matching tasks."""

    resolved_difficulties = difficulties or {"medium", "hard"}
    heap: list[tuple[str, dict[str, Any]]] = []
    for row in _open_lcb_stream(version=version):
        if not _row_matches_filters(row, min_date=min_date, difficulties=resolved_difficulties):
            continue
        contest_date = str(row.get("contest_date") or "")
        qid = str(row.get("question_id"))
        prompt = (row.get("question_content") or "") + LCB_PROMPT_SUFFIX
        try:
            public = json.loads(row["public_test_cases"])
            public_test_count = sum(1 for tc in public if tc.get("testtype") == "stdin")
        except (KeyError, json.JSONDecodeError, TypeError):
            public_test_count = 0
        meta = {
            "task_id": qid,
            "contest_date": contest_date,
            "difficulty": row.get("difficulty"),
            "public_test_count": public_test_count,
            "prompt_sha256": hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
        }
        item = (contest_date, qid, meta)
        if len(heap) < count:
            heapq.heappush(heap, item)
        elif (contest_date, qid) > (heap[0][0], heap[0][1]):
            heapq.heapreplace(heap, item)
    return [meta for _, _, meta in sorted(heap, key=lambda pair: (pair[0], pair[1]), reverse=True)]


def iter_manifest_question_ids(manifest: Mapping[str, Any]) -> Iterator[str]:
    for qid in manifest.get("question_ids") or []:
        yield str(qid)


def decode_tests(row: Mapping[str, Any], max_tests: int) -> list[dict[str, str]]:
    """Decode public + (compressed) private stdin test cases for a problem."""

    tests: list[dict[str, str]] = []
    with contextlib.suppress(KeyError, json.JSONDecodeError, TypeError):
        tests.extend(json.loads(row["public_test_cases"]))
    private = row.get("private_test_cases")
    if isinstance(private, str) and private:
        try:
            tests.extend(json.loads(private))
        except json.JSONDecodeError:
            with contextlib.suppress(Exception):  # best-effort private decode
                tests.extend(
                    json.loads(
                        pickle.loads(zlib.decompress(base64.b64decode(private.encode("utf-8"))))
                    )
                )
    stdin_tests = [t for t in tests if t.get("testtype") == "stdin"]
    return stdin_tests if max_tests <= 0 else stdin_tests[:max_tests]


def decode_public_private(
    row: Mapping[str, Any],
    max_tests: int = 0,
) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    """Decode public and private stdin tests separately.

    Public tests are given to the solver and are used for execution-guided
    selection; private tests are held out and used only for grading, so selecting
    on public and grading on private is leakage-free. Returns (public, private)
    lists of stdin test cases.
    """
    public: list[dict[str, str]] = []
    with contextlib.suppress(KeyError, json.JSONDecodeError, TypeError):
        public.extend(json.loads(row["public_test_cases"]))
    private: list[dict[str, str]] = []
    raw_private = row.get("private_test_cases")
    if isinstance(raw_private, str) and raw_private:
        try:
            private.extend(json.loads(raw_private))
        except json.JSONDecodeError:
            with contextlib.suppress(Exception):  # best-effort compressed private decode
                private.extend(
                    json.loads(
                        pickle.loads(zlib.decompress(base64.b64decode(raw_private.encode("utf-8"))))
                    )
                )
    public_stdin = [t for t in public if t.get("testtype") == "stdin"]
    private_stdin = [t for t in private if t.get("testtype") == "stdin"]
    # Fall back to public when private is unavailable (keeps the task scorable; the
    # adapter records when grading reused public so it is never silently misleading).
    if not private_stdin:
        private_stdin = public_stdin
    if max_tests > 0:
        public_stdin = public_stdin[:max_tests]
        private_stdin = private_stdin[:max_tests]
    return public_stdin, private_stdin


def prepare_tasks(
    problems: Sequence[Mapping[str, Any]],
    *,
    max_tests: int = 0,
) -> list[dict[str, Any]]:
    """Turn raw dataset rows into {task_id, prompt, tests, difficulty} dicts."""

    prepared = []
    for problem in problems:
        prepared.append(
            {
                "task_id": str(problem.get("question_id")),
                "prompt": (problem.get("question_content") or "") + LCB_PROMPT_SUFFIX,
                "tests": decode_tests(problem, max_tests),
                "difficulty": problem.get("difficulty"),
            }
        )
    return prepared


__all__ = [
    "LCB_PROMPT_SUFFIX",
    "decode_public_private",
    "decode_tests",
    "iter_manifest_question_ids",
    "load_manifest",
    "load_problems",
    "prepare_tasks",
    "scan_matching_question_ids",
]
