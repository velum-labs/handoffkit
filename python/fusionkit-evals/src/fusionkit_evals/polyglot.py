"""Aider polyglot benchmark loader + per-language test runner.

A within-run adaptation of the Aider polyglot benchmark (Exercism exercises) for
fusion benchmarking: each panel member writes the complete solution file for an
exercise, and we run that language's real test suite to score pass/fail -- per
candidate and for the fused output -- on the same exercises. This grows the
decision-task pool with multi-language problems that are decorrelated from
LiveCodeBench's competitive-programming style.

This is NOT the official aider harness (no edit-format / two-attempt loop); it is a
single-shot, full-file adaptation used only for the apples-to-apples within-run
individual-vs-compound comparison. Do not compare these numbers to the published
aider leaderboard.

Supported languages here are the ones whose toolchains run cleanly without
per-exercise package installs: python (pytest), go (`go test`), rust (`cargo test`).
Each exercise's `.meta/config.json` declares its solution and test files.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path

from fusionkit_core.fusion import FusionEngine
from fusionkit_core.types import ChatMessage

from fusionkit_evals.candidate_bank import (
    BankCandidate,
    BankTask,
    CandidateBank,
    panel_model_ids,
)
from fusionkit_evals.code_extract import extract_code


@dataclass(frozen=True)
class LanguageSpec:
    """How to find the editable file and run the tests for one language."""

    name: str
    # Test command run in the exercise directory; pass == exit code 0.
    test_command: tuple[str, ...]
    # Extra environment needed by the toolchain (merged over a scrubbed env).
    keep_env: tuple[str, ...] = ()


LANGUAGES: dict[str, LanguageSpec] = {
    "python": LanguageSpec(
        name="python",
        # Use the current interpreter (the uv env, which has pytest).
        test_command=(sys.executable, "-m", "pytest", "-q"),
    ),
    "go": LanguageSpec(
        name="go",
        test_command=("go", "test", "./..."),
        keep_env=("GOPATH", "GOMODCACHE", "GOCACHE", "HOME"),
    ),
    "rust": LanguageSpec(
        name="rust",
        test_command=("cargo", "test", "--quiet"),
        keep_env=("CARGO_HOME", "RUSTUP_HOME", "HOME"),
    ),
}

# A solution entry that is build config, not the file the model should write.
_NON_EDIT_SOLUTION = {"Cargo.toml", "go.mod", "package.json"}


@dataclass(frozen=True)
class PolyglotExercise:
    task_id: str
    language: str
    slug: str
    instructions: str
    solution_rel: str
    stub: str
    exercise_dir: str
    test_rel: tuple[str, ...] = field(default_factory=tuple)


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return ""


def _instructions(exercise_dir: Path) -> str:
    docs = exercise_dir / ".docs"
    parts = [_read(docs / "instructions.md")]
    append = docs / "instructions.append.md"
    if append.exists():
        parts.append(_read(append))
    return "\n\n".join(p for p in parts if p.strip())


def _primary_solution(files_solution: Sequence[str]) -> str | None:
    """The single file the model edits (skip build config like Cargo.toml)."""
    editable = [f for f in files_solution if Path(f).name not in _NON_EDIT_SOLUTION]
    return editable[0] if len(editable) == 1 else None


def load_polyglot_exercises(
    root: str | Path,
    *,
    languages: Sequence[str] = ("python", "go", "rust"),
    subset: int | None = None,
    slugs: Sequence[str] | None = None,
) -> list[PolyglotExercise]:
    """Enumerate practice exercises with a single editable solution file.

    ``root`` is the cloned polyglot-benchmark checkout. Exercises whose solution is
    split across multiple editable files are skipped (single-file keeps full-file
    rewriting reliable). ``subset`` caps the total count (round-robin across
    languages so the mix stays balanced).
    """
    root_path = Path(root)
    want = set(slugs) if slugs is not None else None
    per_language: dict[str, list[PolyglotExercise]] = {}
    for language in languages:
        spec = LANGUAGES.get(language)
        if spec is None:
            continue
        practice = root_path / language / "exercises" / "practice"
        if not practice.is_dir():
            continue
        exercises: list[PolyglotExercise] = []
        for exercise_dir in sorted(practice.iterdir()):
            if not exercise_dir.is_dir():
                continue
            slug = exercise_dir.name
            if want is not None and slug not in want:
                continue
            config_path = exercise_dir / ".meta" / "config.json"
            if not config_path.exists():
                continue
            try:
                config = json.loads(config_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                continue
            files = config.get("files", {})
            solution = _primary_solution(files.get("solution", []))
            tests = tuple(files.get("test", []))
            if solution is None or not tests:
                continue
            stub = _read(exercise_dir / solution)
            instructions = _instructions(exercise_dir)
            if not instructions.strip():
                continue
            exercises.append(
                PolyglotExercise(
                    task_id=f"{language}/{slug}",
                    language=language,
                    slug=slug,
                    instructions=instructions,
                    solution_rel=solution,
                    stub=stub,
                    exercise_dir=str(exercise_dir),
                    test_rel=tests,
                )
            )
        per_language[language] = exercises

    # Round-robin across languages so a subset stays balanced.
    ordered: list[PolyglotExercise] = []
    index = 0
    while True:
        added = False
        for language in languages:
            bucket = per_language.get(language, [])
            if index < len(bucket):
                ordered.append(bucket[index])
                added = True
        if not added:
            break
        index += 1
    return ordered[:subset] if subset is not None else ordered


def build_prompt(exercise: PolyglotExercise) -> str:
    """Prompt asking for the complete solution file as one fenced code block."""
    return (
        f"Solve this {exercise.language} exercise.\n\n"
        f"{exercise.instructions}\n\n"
        f"You must implement the file `{exercise.solution_rel}`. Its current stub is:\n\n"
        f"```{exercise.language}\n{exercise.stub}\n```\n\n"
        f"Return the COMPLETE contents of `{exercise.solution_rel}` as a single fenced "
        f"code block. Do not include tests or any other file."
    )


def _scrubbed_env(spec: LanguageSpec) -> dict[str, str]:
    """Env for the test subprocess: PATH + toolchain vars, no secrets."""
    base: dict[str, str] = {}
    path = os.environ.get("PATH")
    if path:
        base["PATH"] = path
    for name in spec.keep_env:
        value = os.environ.get(name)
        if value:
            base[name] = value
    return base


@dataclass(frozen=True)
class PolyglotRun:
    passed: bool
    exit_code: int
    timed_out: bool
    detail: str = ""


def run_polyglot(
    exercise: PolyglotExercise,
    candidate_code: str,
    *,
    timeout_s: float = 120.0,
) -> PolyglotRun:
    """Write ``candidate_code`` as the solution file in a temp copy, run the tests.

    Returns pass/fail by exit code. The exercise directory is copied so the source
    checkout is never mutated; the test subprocess runs with a scrubbed env (no API
    keys) and a wall-clock timeout.
    """
    spec = LANGUAGES[exercise.language]
    if not candidate_code.strip():
        return PolyglotRun(passed=False, exit_code=-1, timed_out=False, detail="empty solution")
    with tempfile.TemporaryDirectory(prefix=f"polyglot-{exercise.language}-") as tmp:
        work = Path(tmp) / exercise.slug
        shutil.copytree(exercise.exercise_dir, work)
        (work / exercise.solution_rel).write_text(candidate_code, encoding="utf-8")
        command = list(spec.test_command)
        if exercise.language == "python":
            command.extend(exercise.test_rel)
        try:
            proc = subprocess.run(
                command,
                cwd=work,
                env=_scrubbed_env(spec),
                capture_output=True,
                text=True,
                timeout=timeout_s,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return PolyglotRun(passed=False, exit_code=124, timed_out=True, detail="timeout")
        except FileNotFoundError as exc:
            return PolyglotRun(passed=False, exit_code=127, timed_out=False, detail=str(exc))
        detail = (proc.stdout[-1500:] + proc.stderr[-1500:]).strip()
        return PolyglotRun(
            passed=proc.returncode == 0,
            exit_code=proc.returncode,
            timed_out=False,
            detail=detail,
        )


def _bank_log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def _task_cache_path(cache_dir: Path, signature: str, task_id: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", task_id)
    return cache_dir / f"{safe}__{signature}.json"


async def build_polyglot_bank(
    engine: FusionEngine,
    exercises: Sequence[PolyglotExercise],
    *,
    signature: str,
    timeout_s: float = 120.0,
    gen_timeout_s: float = 240.0,
    concurrency: int = 3,
    cache_dir: str | Path | None = None,
) -> tuple[CandidateBank, dict[str, PolyglotExercise]]:
    """Generate panel candidates per exercise and score each by running its tests.

    Mirrors :func:`~fusionkit_evals.candidate_bank.build_candidate_bank` but for
    polyglot (full-file, per-language test commands). Returns the frozen bank plus a
    task_id -> exercise map the replay verifier needs.

    Robust for the autonomous loop: per-task logging, a per-task generation timeout
    (a hung request can never deadlock the batch), scoring bounded by the same
    concurrency slot as generation (no unbounded compile fan-out), and optional
    per-task disk caching (``cache_dir``) so partial progress survives a restart and
    reruns skip completed tasks.
    """
    models = panel_model_ids(engine)
    semaphore = asyncio.Semaphore(max(1, concurrency))
    exercise_map = {exercise.task_id: exercise for exercise in exercises}
    cache_path = Path(cache_dir) if cache_dir is not None else None
    if cache_path is not None:
        cache_path.mkdir(parents=True, exist_ok=True)

    def _load_cached(task_id: str) -> BankTask | None:
        if cache_path is None:
            return None
        path = _task_cache_path(cache_path, signature, task_id)
        if not path.exists():
            return None
        try:
            return BankTask.model_validate_json(path.read_text(encoding="utf-8"))
        except ValueError:
            return None

    def _save_cached(task: BankTask) -> None:
        if cache_path is None:
            return
        path = _task_cache_path(cache_path, signature, task.task_id)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(task.model_dump_json(), encoding="utf-8")
        tmp.replace(path)

    async def build_one(exercise: PolyglotExercise) -> BankTask | None:
        cached = _load_cached(exercise.task_id)
        if cached is not None:
            _bank_log(f"  {exercise.task_id}: cached ({cached.n_pass} pass)")
            return cached
        async with semaphore:
            try:
                candidates = await asyncio.wait_for(
                    engine.producer.generate_panel(
                        models,
                        [ChatMessage(role="user", content=build_prompt(exercise))],
                        engine.config.sampling,
                    ),
                    timeout=gen_timeout_s,
                )
            except Exception as exc:  # noqa: BLE001 - skip (incl. timeout), never deadlock
                _bank_log(f"  {exercise.task_id}: generation skipped ({type(exc).__name__})")
                return None
            bank_candidates: list[BankCandidate] = []
            for candidate in candidates:
                code = extract_code(candidate.content).code
                run = await asyncio.to_thread(run_polyglot, exercise, code, timeout_s=timeout_s)
                bank_candidates.append(
                    BankCandidate(
                        model_id=candidate.model_id, content=candidate.content, passed=run.passed
                    )
                )
        task = BankTask(
            task_id=exercise.task_id,
            prompt=build_prompt(exercise),
            tests=[],
            difficulty=exercise.language,
            candidates=bank_candidates,
        )
        _save_cached(task)
        flags = " ".join(f"{c.model_id}={'P' if c.passed else 'F'}" for c in bank_candidates)
        _bank_log(f"  {exercise.task_id}: {flags}")
        return task

    _bank_log(f"building polyglot bank: {len(exercises)} exercises, panel={models}")
    built = await asyncio.gather(*(build_one(exercise) for exercise in exercises))
    tasks = [task for task in built if task is not None]
    _bank_log(f"built polyglot bank: {len(tasks)}/{len(exercises)} tasks")
    return CandidateBank(signature=signature, panel_models=models, tasks=tasks), exercise_map


def polyglot_verifier(
    exercise_map: dict[str, PolyglotExercise],
    *,
    timeout_s: float = 120.0,
) -> Callable[[BankTask, str], bool]:
    """A replay verifier (BankTask, code) -> passed that runs the polyglot tests."""

    def verify(task: BankTask, code: str) -> bool:
        exercise = exercise_map.get(task.task_id)
        if exercise is None:
            return False
        return run_polyglot(exercise, code, timeout_s=timeout_s).passed

    return verify


__all__ = [
    "LANGUAGES",
    "LanguageSpec",
    "PolyglotExercise",
    "PolyglotRun",
    "build_polyglot_bank",
    "build_prompt",
    "load_polyglot_exercises",
    "polyglot_verifier",
    "run_polyglot",
]
