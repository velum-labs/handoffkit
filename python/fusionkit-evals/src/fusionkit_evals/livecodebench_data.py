"""LiveCodeBench dataset loading and test decoding (importable).

Factored out of the runner adapter so both the adapter and the tuning
candidate-bank builder load problems and decode tests identically. The
``datasets`` dependency is imported lazily (install with ``datasets<4``).
"""

from __future__ import annotations

import base64
import contextlib
import json
import pickle
import sys
import zlib
from collections.abc import Mapping, Sequence
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


def load_problems(
    subset: int,
    *,
    version: str = "release_v6",
    min_date: str = "2025-01-01",
    difficulties: set[str] | None = None,
    manifest: Mapping[str, Any] | None = None,
) -> list[dict[str, Any]]:
    # Imported lazily (runtime-only optional dep); install with `datasets<4`.
    from datasets import load_dataset  # pyright: ignore[reportMissingImports]

    resolved_version = (manifest or {}).get("version") or version
    _log(f"loading livecodebench/code_generation_lite {resolved_version} (datasets<4) ...")
    ds = load_dataset(
        "livecodebench/code_generation_lite",
        split="test",
        version_tag=resolved_version,
        trust_remote_code=True,
    )
    if manifest is not None:
        return _select_from_manifest(ds, manifest)
    return _select_recent(
        ds,
        subset,
        min_date=min_date,
        difficulties=difficulties or {"medium", "hard"},
    )


def _select_from_manifest(ds: Any, manifest: Mapping[str, Any]) -> list[dict[str, Any]]:
    wanted = list(manifest.get("question_ids") or [])
    by_id = {str(row.get("question_id")): row for row in ds}
    chosen = [by_id[qid] for qid in wanted if qid in by_id]
    missing = [qid for qid in wanted if qid not in by_id]
    if missing:
        _log(f"manifest: {len(missing)} question_ids not found: {missing[:5]}")
    _log(f"selected {len(chosen)} problems from frozen manifest")
    return chosen


def _select_recent(
    ds: Any,
    subset: int,
    *,
    min_date: str,
    difficulties: set[str],
) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    for row in ds:
        if (row.get("difficulty") or "").lower() not in difficulties:
            continue
        if str(row.get("contest_date") or "") < min_date:
            continue
        try:
            public = json.loads(row["public_test_cases"])
        except (KeyError, json.JSONDecodeError, TypeError):
            continue
        if any(tc.get("testtype") != "stdin" for tc in public):
            continue  # only faithful-to-execute stdin problems
        if row.get("starter_code"):
            continue  # skip functional-call problems
        selected.append(row)
    selected.sort(key=lambda r: str(r.get("contest_date")), reverse=True)
    chosen = selected[:subset]
    _log(f"selected {len(chosen)} problems (difficulty={sorted(difficulties)}, >= {min_date})")
    return chosen


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
    "load_manifest",
    "load_problems",
    "prepare_tasks",
]
