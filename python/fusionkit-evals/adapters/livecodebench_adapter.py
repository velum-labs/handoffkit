"""LiveCodeBench runner adapter for `fusionkit public-bench --suite livecodebench`.

A real, high-fidelity, unsaturated coding benchmark adapter. It loads the official
LiveCodeBench `code_generation_lite` dataset, filters to recent medium/hard
stdin problems (a post-cutoff window for contamination control), runs live panel
fusion in-process, and executes each candidate's and the fused program against the
real public + private test cases (stdin -> stdout, all-or-nothing per problem, as
LiveCodeBench scores pass@1).

Contract: reads an ExternalBenchmarkRequest JSON on stdin, writes a normalized run
envelope JSON on stdout (everything else goes to stderr). Requires:
  - `datasets<4` installed (the dataset uses a loading script),
  - `FUSIONKIT_BENCH_CONFIG` pointing at a FusionConfig YAML (the panel),
  - provider API keys in the environment.

Untrusted solution code runs in a pluggable sandbox (env ``BENCH_SANDBOX``,
default ``local``) with a scrubbed environment (no API keys), resource limits, and
an output cap. Tasks are cached/resumable and run concurrently; failures are
classified (model_failed/infra_error/excluded) and transient ones retried, so a
hard task is never silently dropped.

Optional env overrides: LCB_VERSION (default release_v6), LCB_MIN_DATE
(ISO date, default 2025-01-01), LCB_DIFFICULTY (comma list, default medium,hard),
LCB_MAX_TESTS (per problem, default 0 = full official set), LCB_TEST_TIMEOUT_S
(default 8), LCB_CONCURRENCY (default 4), LCB_RETRIES (default 3), LCB_CHECKER
(exact|token|float|case_insensitive, default exact), LCB_CACHE_DIR,
LCB_ARTIFACTS_DIR, BENCH_SANDBOX (local|docker).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

from fusionkit_core.clients import build_clients
from fusionkit_core.config import load_config
from fusionkit_core.fusion import FusionEngine
from fusionkit_core.providers import estimate_cost
from fusionkit_core.types import ChatMessage
from fusionkit_evals.bench_runtime import classify_exception, retry_async
from fusionkit_evals.bench_verify import verify_solution
from fusionkit_evals.checkers import CheckerMode
from fusionkit_evals.code_extract import extract_code
from fusionkit_evals.livecodebench_data import (
    LCB_PROMPT_SUFFIX,
    decode_tests,
    load_manifest,
    load_problems,
)
from fusionkit_evals.provenance import build_provenance
from fusionkit_evals.sandbox import Sandbox, SandboxConfig, build_sandbox

# Bump when extraction/checker/execution logic changes so cached rows are recomputed.
SCORING_VERSION = "2"

PROMPT_SUFFIX = LCB_PROMPT_SUFFIX


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def cache_dir() -> Path:
    path = Path(
        os.environ.get(
            "LCB_CACHE_DIR",
            str(Path.home() / ".cache" / "fusionkit-bench" / "livecodebench"),
        )
    )
    path.mkdir(parents=True, exist_ok=True)
    return path


def panel_signature(engine: FusionEngine, max_tests: int) -> str:
    """A stable id for the panel + scoring config; changing any of it busts the cache."""

    config = engine.config
    payload = {
        "endpoints": sorted((e.id, e.model, e.provider) for e in config.endpoints),
        "judge": config.resolved_judge_model,
        "synthesizer": config.resolved_synthesizer_model,
        "panel_models": sorted(config.panel_models),
        "max_tokens": config.sampling.max_tokens,
        "prompt_suffix": PROMPT_SUFFIX,
        "version": os.environ.get("LCB_VERSION", "release_v6"),
        "max_tests": max_tests,
        "scoring_version": SCORING_VERSION,
        "checker_mode": os.environ.get("LCB_CHECKER", "exact"),
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:16]


def cache_path(signature: str, task_id: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", task_id)
    return cache_dir() / f"{safe}__{signature}.json"


def load_cached_row(signature: str, task_id: str) -> dict[str, Any] | None:
    path = cache_path(signature, task_id)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


def save_cached_row(signature: str, row: dict[str, Any]) -> None:
    path = cache_path(signature, row["task_id"])
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(row), encoding="utf-8")
    tmp.replace(path)  # atomic, so a crash mid-write never leaves a corrupt cache entry


def artifacts_dir() -> Path:
    path = Path(os.environ.get("LCB_ARTIFACTS_DIR", str(cache_dir() / "artifacts")))
    path.mkdir(parents=True, exist_ok=True)
    return path


def _write_artifacts(signature: str, task_id: str, payload: dict[str, Any]) -> None:
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", f"{task_id}__{signature}")
    (artifacts_dir() / f"{safe}.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")


async def evaluate_problem(
    engine: FusionEngine,
    sandbox: Sandbox,
    problem: dict[str, Any],
    *,
    signature: str,
    max_tests: int,
    test_timeout: float,
    checker_mode: CheckerMode,
    semaphore: asyncio.Semaphore,
) -> dict[str, Any]:
    question_id = str(problem.get("question_id"))
    cached = load_cached_row(signature, question_id)
    if cached is not None:
        mark = "P" if cached.get("passed") else "F"
        log(f"  {question_id}: cached ({cached.get('outcome')}/{mark})")
        return cached
    tests = decode_tests(problem, max_tests)
    if not tests:
        # Keep it in the accounting as an explicit exclusion, never a silent drop.
        return _terminal_row(signature, question_id, "excluded", "no_usable_stdin_tests")
    prompt = (problem.get("question_content") or "") + PROMPT_SUFFIX
    async with semaphore:
        started = time.monotonic()
        try:
            result = await retry_async(
                lambda: engine.run([ChatMessage(role="user", content=prompt)], mode="panel"),
                attempts=int(os.environ.get("LCB_RETRIES", "3")),
            )
        except Exception as exc:  # noqa: BLE001 - classify rather than abort the batch
            outcome = classify_exception(exc)
            log(f"  {question_id}: {outcome} after retries ({exc})")
            return _terminal_row(signature, question_id, outcome, str(exc)[:500])
        latency = time.monotonic() - started
    scored = await asyncio.to_thread(
        _score_result, sandbox, result, tests, test_timeout, checker_mode
    )
    cost = 0.0
    for cand in result.trajectories:
        est = _candidate_cost(engine, cand.model_id, cand.metadata.get("usage"))
        if est is not None:
            cost += est
    row = {
        "task_id": question_id,
        "outcome": "scored",
        "passed": scored["fused_pass"],
        "score": 1.0 if scored["fused_pass"] else 0.0,
        "cost_usd": round(cost, 6),
        "latency_s": round(latency, 2),
        "candidate_scores": scored["candidate_scores"],
    }
    _write_artifacts(
        signature,
        question_id,
        {
            **row,
            "difficulty": problem.get("difficulty"),
            "num_tests": len(tests),
            "fused_extraction_method": scored["fused_method"],
            "fused_raw_output": scored["fused_raw"],
            "fused_code": scored["fused_code"],
            "fused_per_test": scored["fused_per_test"],
            "fused_stderr": scored["fused_stderr"],
            "candidate_methods": scored["candidate_methods"],
        },
    )
    save_cached_row(signature, row)
    flags = " ".join(f"{m}={'P' if s else 'F'}" for m, s in scored["candidate_scores"].items())
    log(
        f"  {question_id} ({problem.get('difficulty')}, {len(tests)} tests) "
        f"fused={'PASS' if scored['fused_pass'] else 'FAIL'}  {flags}"
    )
    return row


def _terminal_row(signature: str, task_id: str, outcome: str, reason: str) -> dict[str, Any]:
    row = {
        "task_id": task_id,
        "outcome": outcome,
        "passed": None,
        "score": None,
        "candidate_scores": {},
        "error_reason": reason,
    }
    # Cache exclusions (deterministic) but not infra errors (worth retrying next run).
    if outcome == "excluded":
        save_cached_row(signature, row)
    return row


def _score_result(
    sandbox: Sandbox,
    result: Any,
    tests: list[dict[str, str]],
    test_timeout: float,
    checker_mode: CheckerMode,
) -> dict[str, Any]:
    fused = extract_code(result.content)
    fused_run = verify_solution(
        sandbox, fused.code, tests, timeout_s=test_timeout, checker_mode=checker_mode
    )
    candidate_scores: dict[str, float] = {}
    candidate_methods: dict[str, str] = {}
    for cand in result.trajectories:
        extracted = extract_code(cand.content)
        run = verify_solution(
            sandbox, extracted.code, tests, timeout_s=test_timeout, checker_mode=checker_mode
        )
        candidate_scores[cand.model_id] = 1.0 if run.passed else 0.0
        candidate_methods[cand.model_id] = extracted.method
    return {
        "fused_pass": fused_run.passed,
        "fused_method": fused.method,
        "fused_code": fused.code,
        "fused_raw": result.content,
        "fused_per_test": fused_run.per_test,
        "fused_stderr": fused_run.stderr,
        "candidate_scores": candidate_scores,
        "candidate_methods": candidate_methods,
    }


async def main() -> None:
    request = json.load(sys.stdin)
    subset = int(request.get("subset") or 10)
    max_tests = int(os.environ.get("LCB_MAX_TESTS", "0"))  # 0 = full official test set
    test_timeout = float(os.environ.get("LCB_TEST_TIMEOUT_S", "8"))
    concurrency = max(1, int(os.environ.get("LCB_CONCURRENCY", "4")))
    checker_mode: CheckerMode = _resolve_checker_mode(os.environ.get("LCB_CHECKER", "exact"))
    config_path = os.environ.get("FUSIONKIT_BENCH_CONFIG")
    if not config_path:
        raise SystemExit("FUSIONKIT_BENCH_CONFIG must point at a FusionConfig YAML")

    config = load_config(config_path)
    engine = FusionEngine(config=config, clients=build_clients(config))
    sandbox = build_sandbox(SandboxConfig(backend=os.environ.get("BENCH_SANDBOX", "local")))
    difficulties = {
        d.strip().lower()
        for d in os.environ.get("LCB_DIFFICULTY", "medium,hard").split(",")
        if d.strip()
    }
    problems = load_problems(
        subset,
        version=os.environ.get("LCB_VERSION", "release_v6"),
        min_date=os.environ.get("LCB_MIN_DATE", "2025-01-01"),
        difficulties=difficulties,
        manifest=load_manifest(os.environ.get("LCB_MANIFEST")),
    )
    signature = panel_signature(engine, max_tests)
    semaphore = asyncio.Semaphore(concurrency)
    log(
        f"evaluating {len(problems)} problems (concurrency={concurrency}, "
        f"sandbox={sandbox.backend}, checker={checker_mode}, sig={signature})"
    )

    rows = await asyncio.gather(
        *(
            evaluate_problem(
                engine,
                sandbox,
                problem,
                signature=signature,
                max_tests=max_tests,
                test_timeout=test_timeout,
                checker_mode=checker_mode,
                semaphore=semaphore,
            )
            for problem in problems
        )
    )
    scored = [r for r in rows if r["outcome"] == "scored"]

    envelope = {
        "suite": "livecodebench",
        "mount_mode": "fusion_behind_agent",
        "harness": "livecodebench-code_generation_lite",
        "harness_version": os.environ.get("LCB_VERSION", "release_v6"),
        "model": request.get("gateway_model", "fusionkit/panel"),
        "resolved_tasks": len(scored),
        "total_tasks": len(rows),
        "passed_tasks": sum(1 for r in scored if r["passed"]),
        "cost_total_usd": round(sum(r.get("cost_usd") or 0.0 for r in rows), 6),
        "tasks": rows,
        "provenance": build_provenance(
            prompt_template=PROMPT_SUFFIX,
            model_versions={e.id: e.model for e in config.endpoints},
            dataset_revision=os.environ.get("LCB_VERSION", "release_v6"),
            extra={
                "checker_mode": checker_mode,
                "sandbox_backend": sandbox.backend,
                "scoring_version": SCORING_VERSION,
                "contamination_window_min_date": os.environ.get("LCB_MIN_DATE", "2025-01-01"),
                "manifest": os.environ.get("LCB_MANIFEST"),
                # judge+synth token cost is not surfaced in-process today; see docs.
                "cost_scope": "solver_candidates_only",
            },
        ),
        "metadata": {
            "difficulty": os.environ.get("LCB_DIFFICULTY", "medium,hard"),
            "concurrency": concurrency,
            "cache_signature": signature,
        },
    }
    json.dump(envelope, sys.stdout)


def _resolve_checker_mode(value: str) -> CheckerMode:
    if value in ("exact", "token", "float", "case_insensitive"):
        return value
    return "exact"


def _candidate_cost(engine: FusionEngine, model_id: str, usage: object) -> float | None:
    try:
        endpoint = engine.config.endpoint_for(model_id)
    except KeyError:
        return None
    return estimate_cost(endpoint, usage if isinstance(usage, dict) else None)


if __name__ == "__main__":
    asyncio.run(main())
