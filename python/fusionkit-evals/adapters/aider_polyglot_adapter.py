"""Aider-polyglot runner adapter for `fusionkit public-bench --suite aider-polyglot`.

A within-run adaptation (NOT the official aider harness): each panel member writes
the complete solution file for an Exercism exercise, and we run that language's real
test suite (pytest / `go test` / `cargo test`) to score pass/fail -- per candidate
and for the fused output -- on the same exercises. This grows the decision-task pool
with multi-language problems decorrelated from LiveCodeBench, for the apples-to-apples
individual-vs-compound comparison. Numbers are not comparable to the published aider
leaderboard.

Contract: reads an ExternalBenchmarkRequest JSON on stdin, writes a normalized run
envelope JSON on stdout (everything else to stderr). Requires:
  - a cloned polyglot-benchmark at POLYGLOT_ROOT (default ~/.cache/fusionkit-bench/polyglot),
  - FUSIONKIT_BENCH_CONFIG pointing at a FusionConfig YAML (the panel),
  - provider API keys, plus the toolchains for the selected languages.

Env overrides: POLYGLOT_ROOT, POLYGLOT_LANGUAGES (default python,go,rust),
POLYGLOT_TIMEOUT_S (default 120), POLYGLOT_CONCURRENCY (default 3),
POLYGLOT_CACHE_DIR, POLYGLOT_ARTIFACTS_DIR.
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
from fusionkit_evals.code_extract import extract_code
from fusionkit_evals.polyglot import (
    PolyglotExercise,
    build_prompt,
    load_polyglot_exercises,
    run_polyglot,
)
from fusionkit_evals.provenance import build_provenance

SCORING_VERSION = "1"


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def _root() -> Path:
    default = str(Path.home() / ".cache" / "fusionkit-bench" / "polyglot")
    return Path(os.environ.get("POLYGLOT_ROOT", default))


def _languages() -> list[str]:
    raw = os.environ.get("POLYGLOT_LANGUAGES", "python,go,rust")
    return [item.strip() for item in raw.split(",") if item.strip()]


def cache_dir() -> Path:
    path = Path(
        os.environ.get(
            "POLYGLOT_CACHE_DIR",
            str(Path.home() / ".cache" / "fusionkit-bench" / "polyglot-runs"),
        )
    )
    path.mkdir(parents=True, exist_ok=True)
    return path


def panel_signature(engine: FusionEngine, languages: list[str]) -> str:
    config = engine.config
    payload = {
        "endpoints": sorted((e.id, e.model, e.provider) for e in config.endpoints),
        "judge": config.resolved_judge_model,
        "synthesizer": config.resolved_synthesizer_model,
        "panel_models": sorted(config.panel_models),
        "max_tokens": config.sampling.max_tokens,
        "languages": sorted(languages),
        "scoring_version": SCORING_VERSION,
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
    tmp.replace(path)


def _candidate_cost(engine: FusionEngine, model_id: str, usage: object) -> float | None:
    try:
        endpoint = engine.config.endpoint_for(model_id)
    except KeyError:
        return None
    return estimate_cost(endpoint, usage if isinstance(usage, dict) else None)


async def evaluate_exercise(
    engine: FusionEngine,
    exercise: PolyglotExercise,
    *,
    signature: str,
    timeout_s: float,
    semaphore: asyncio.Semaphore,
) -> dict[str, Any]:
    cached = load_cached_row(signature, exercise.task_id)
    if cached is not None:
        mark = "P" if cached.get("passed") else "F"
        log(f"  {exercise.task_id}: cached ({cached.get('outcome')}/{mark})")
        return cached

    prompt = build_prompt(exercise)
    async with semaphore:
        started = time.monotonic()
        try:
            result = await retry_async(
                lambda: engine.run([ChatMessage(role="user", content=prompt)], mode="panel"),
                attempts=int(os.environ.get("POLYGLOT_RETRIES", "3")),
            )
        except Exception as exc:  # noqa: BLE001 - classify rather than abort the batch
            outcome = classify_exception(exc)
            log(f"  {exercise.task_id}: {outcome} after retries ({exc})")
            return _terminal_row(signature, exercise.task_id, outcome, str(exc)[:500])
        latency = time.monotonic() - started

    # Score the fused output and each candidate by running the real test suite.
    fused_code = extract_code(result.content).code
    fused_run = await asyncio.to_thread(run_polyglot, exercise, fused_code, timeout_s=timeout_s)
    candidate_scores: dict[str, float] = {}
    for trajectory in result.trajectories:
        code = extract_code(trajectory.content).code
        run = await asyncio.to_thread(run_polyglot, exercise, code, timeout_s=timeout_s)
        candidate_scores[trajectory.model_id] = 1.0 if run.passed else 0.0

    cost = 0.0
    for trajectory in result.trajectories:
        est = _candidate_cost(engine, trajectory.model_id, trajectory.metadata.get("usage"))
        if est is not None:
            cost += est

    row = {
        "task_id": exercise.task_id,
        "outcome": "scored",
        "passed": fused_run.passed,
        "score": 1.0 if fused_run.passed else 0.0,
        "cost_usd": round(cost, 6),
        "latency_s": round(latency, 2),
        "candidate_scores": candidate_scores,
    }
    save_cached_row(signature, row)
    flags = " ".join(f"{m}={'P' if s else 'F'}" for m, s in candidate_scores.items())
    log(f"  {exercise.task_id} fused={'PASS' if fused_run.passed else 'FAIL'}  {flags}")
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
    if outcome == "excluded":
        save_cached_row(signature, row)
    return row


async def main() -> None:
    request = json.load(sys.stdin)
    subset = int(request.get("subset") or 10)
    timeout_s = float(os.environ.get("POLYGLOT_TIMEOUT_S", "120"))
    concurrency = max(1, int(os.environ.get("POLYGLOT_CONCURRENCY", "3")))
    config_path = os.environ.get("FUSIONKIT_BENCH_CONFIG")
    if not config_path:
        raise SystemExit("FUSIONKIT_BENCH_CONFIG must point at a FusionConfig YAML")

    config = load_config(config_path)
    engine = FusionEngine(config=config, clients=build_clients(config))
    languages = _languages()
    exercises = load_polyglot_exercises(_root(), languages=languages, subset=subset)
    signature = panel_signature(engine, languages)
    semaphore = asyncio.Semaphore(concurrency)
    log(
        f"evaluating {len(exercises)} polyglot exercises "
        f"(languages={languages}, concurrency={concurrency}, sig={signature})"
    )

    rows = await asyncio.gather(
        *(
            evaluate_exercise(
                engine, exercise, signature=signature, timeout_s=timeout_s, semaphore=semaphore
            )
            for exercise in exercises
        )
    )
    scored = [r for r in rows if r["outcome"] == "scored"]

    envelope = {
        "suite": "aider-polyglot",
        "mount_mode": "fusion_behind_agent",
        "harness": "aider-polyglot-within-run-adaptation",
        "harness_version": "single-shot-full-file",
        "model": request.get("gateway_model", "fusionkit/panel"),
        "resolved_tasks": len(scored),
        "total_tasks": len(rows),
        "passed_tasks": sum(1 for r in scored if r["passed"]),
        "cost_total_usd": round(sum(r.get("cost_usd") or 0.0 for r in rows), 6),
        "tasks": rows,
        "provenance": build_provenance(
            prompt_template="polyglot full-file single-shot",
            model_versions={e.id: e.model for e in config.endpoints},
            dataset_revision="polyglot-benchmark@main",
            extra={
                "languages": languages,
                "scoring_version": SCORING_VERSION,
                "methodology": (
                    "within-run single-shot full-file adaptation; not the official aider harness"
                ),
                "cost_scope": "solver_candidates_only",
            },
        ),
        "metadata": {"languages": ",".join(languages), "concurrency": concurrency},
    }
    json.dump(envelope, sys.stdout)


if __name__ == "__main__":
    asyncio.run(main())
