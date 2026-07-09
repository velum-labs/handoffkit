#!/usr/bin/env python3
"""Run Phase C panel benchmarks with a preregistered spend cap.

Sequentially runs `fusionkit public-bench` for H1/H2/H5 using the frozen
manifest. Stops when the cumulative reported cost reaches the cap.

Usage:
  uv run --with 'datasets<4' python labruns/2026-q3/scripts/run_phase_c.py preflight
  uv run --with 'datasets<4' python labruns/2026-q3/scripts/run_phase_c.py run --hypothesis h1
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import shlex
import subprocess
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
MANIFEST = REPO / "labruns" / "2026-q3" / "manifest-algorithmic.json"
ADAPTER = (
    REPO / "python" / "fusionkit-evals" / "src" / "fusionkit_evals"
    / "adapters" / "livecodebench_adapter.py"
)
OUT_DIR = REPO / "labdata" / "runs" / "2026-q3" / "phase-c"
SPEND_LEDGER = OUT_DIR / "spend_ledger.jsonl"
RUNNER_PREFIX = ["uv", "run", "--with", "datasets<4"]

LEGACY_PANELS: dict[str, str] = {
    "h1": "configs/benchmark-panel.h1-backbone.yaml",
    "h2": "configs/benchmark-panel.h2-style-diverse.yaml",
    "h5": "configs/benchmark-panel.h5-thinking-heavy.yaml",
}
JUDGE_EXP_PANELS: dict[str, str] = {
    "j1-g": "configs/benchmark-panel.judge-exp.j1-gemini.yaml",
    "j1-m": "configs/benchmark-panel.judge-exp.j1-mimo.yaml",
    "j2-g": "configs/benchmark-panel.judge-exp.j2-gemini.yaml",
    "j2-m": "configs/benchmark-panel.judge-exp.j2-mimo.yaml",
    "j3-g": "configs/benchmark-panel.judge-exp.j3-gemini.yaml",
    "j3-m": "configs/benchmark-panel.judge-exp.j3-mimo.yaml",
}
ORACLE_EXP_PANELS: dict[str, str] = {
    "e1": "configs/benchmark-panel.exp.e1-gpt55-solo.yaml",
    "p1": "configs/benchmark-panel.exp.p1-kimi-dsv4.yaml",
    "p2": "configs/benchmark-panel.exp.p2-qwen-glm.yaml",
    "p3": "configs/benchmark-panel.exp.p3-kimi-glm.yaml",
}
SOLO_PANELS: dict[str, str] = {
    "s1": "configs/benchmark-panel.solo.s1-qwen3-max-thinking.yaml",
    "s2": "configs/benchmark-panel.solo.s2-kimi-k2-thinking.yaml",
    "s3": "configs/benchmark-panel.solo.s3-nemotron-ultra.yaml",
    "s4": "configs/benchmark-panel.solo.s4-mistral-large.yaml",
    "s5": "configs/benchmark-panel.solo.s5-laguna.yaml",
    "s6": "configs/benchmark-panel.solo.s6-gpt-oss-120b.yaml",
    "s7": "configs/benchmark-panel.solo.s7-glm52.yaml",
    "s8": "configs/benchmark-panel.solo.s8-qwen3-coder.yaml",
}
PANELS: dict[str, str] = {
    **LEGACY_PANELS,
    **JUDGE_EXP_PANELS,
    **ORACLE_EXP_PANELS,
    **SOLO_PANELS,
}
JUDGE_MATRIX_ORDER = ("j1-g", "j1-m", "j2-g", "j2-m", "j3-g", "j3-m")
JUDGE_MIMO_ORDER = ("j1-m", "j2-m", "j3-m")
JUDGE_GEMINI_ORDER = ("j1-g", "j2-g", "j3-g")
ORACLE_EXP_ORDER = ("e1", "p1", "p2", "p3")
SOLO_ORDER = ("s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8")
SPEND_CAP_USD = 75.0
PREFLIGHT_TIMEOUT_S = 7200.0
PANEL_TIMEOUT_S = 21600.0


@dataclass
class RunResult:
    hypothesis: str
    config: str
    subset: int | None
    output_path: Path
    fusion_score: float | None
    passed_tasks: int | None
    resolved_tasks: int | None
    cost_usd: float
    availability: str
    raw: dict[str, object]


def _require_openrouter() -> None:
    if not os.environ.get("OPENROUTER_API_KEY"):
        print("OPENROUTER_API_KEY is required", file=sys.stderr)
        raise SystemExit(2)


def _require_manifest() -> None:
    if not MANIFEST.is_file():
        print(f"missing manifest: {MANIFEST} (run build_manifest.py first)", file=sys.stderr)
        raise SystemExit(2)


def _ledger_total() -> float:
    if not SPEND_LEDGER.is_file():
        return 0.0
    total = 0.0
    for line in SPEND_LEDGER.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        total += float(json.loads(line).get("cost_usd") or 0.0)
    return total


def _append_ledger(entry: dict[str, object]) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with SPEND_LEDGER.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, sort_keys=True) + "\n")


def _adapter_command() -> list[str]:
    return [
        *RUNNER_PREFIX,
        "python",
        str(ADAPTER),
    ]


def _public_bench(
    *,
    config_rel: str,
    subset: int | None,
    output: Path,
    report: Path,
    runner_timeout_s: float,
) -> RunResult:
    env = os.environ.copy()
    env["FUSIONKIT_BENCH_CONFIG"] = str(REPO / config_rel)
    env["LCB_MANIFEST"] = str(MANIFEST)
    env["BENCH_SANDBOX"] = env.get("BENCH_SANDBOX", "local")
    env["LCB_CONCURRENCY"] = env.get("LCB_CONCURRENCY", "2")

    cmd = [
        *RUNNER_PREFIX,
        "fusionkit",
        "public-bench",
        "--suite",
        "livecodebench",
        *(["--subset", str(subset)] if subset is not None else []),
        "--runner-command",
        shlex.join(_adapter_command()),
        "-o",
        str(output),
        "--report",
        str(report),
        "--runner-timeout-s",
        str(runner_timeout_s),
    ]
    proc = subprocess.run(
        cmd,
        cwd=REPO,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        print(proc.stdout, file=sys.stderr)
        print(proc.stderr, file=sys.stderr)
        raise SystemExit(proc.returncode)

    summary = json.loads(proc.stdout.strip().splitlines()[-1])
    run_line = output.read_text(encoding="utf-8").strip().splitlines()[-1]
    run_data = json.loads(run_line)
    cost = float(run_data.get("cost_total_usd") or 0.0)
    return RunResult(
        hypothesis="",
        config=config_rel,
        subset=subset,
        output_path=output,
        fusion_score=_as_float(summary.get("fusion_score")),
        passed_tasks=_as_int(run_data.get("passed_tasks")),
        resolved_tasks=_as_int(run_data.get("resolved_tasks")),
        cost_usd=cost,
        availability=str(summary.get("availability") or "unknown"),
        raw={"summary": summary, "run": run_data},
    )


def _as_float(value: object) -> float | None:
    if value is None:
        return None
    return float(value)


def _as_int(value: object) -> int | None:
    if value is None:
        return None
    return int(value)


def _summarize_member_pass_rates(run_data: dict[str, object]) -> dict[str, float]:
    tasks = run_data.get("tasks")
    if not isinstance(tasks, list):
        return {}
    scores: dict[str, list[float]] = {}
    for row in tasks:
        if not isinstance(row, dict) or row.get("outcome") != "scored":
            continue
        candidate_scores = row.get("candidate_scores")
        if not isinstance(candidate_scores, dict):
            continue
        for model_id, score in candidate_scores.items():
            scores.setdefault(str(model_id), []).append(float(score or 0.0))
    return {
        model_id: (sum(vals) / len(vals) if vals else 0.0) for model_id, vals in scores.items()
    }


def run_preflight(hypothesis: str = "h1") -> RunResult:
    _require_openrouter()
    _require_manifest()
    config = PANELS[hypothesis]
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    output = OUT_DIR / f"preflight-{hypothesis}-{stamp}.jsonl"
    report = OUT_DIR / f"preflight-{hypothesis}-{stamp}.md"
    result = _public_bench(
        config_rel=config,
        subset=5,
        output=output,
        report=report,
        runner_timeout_s=PREFLIGHT_TIMEOUT_S,
    )
    result.hypothesis = hypothesis
    _append_ledger(
        {
            "phase": "preflight",
            "hypothesis": hypothesis,
            "config": config,
            "subset": 5,
            "cost_usd": result.cost_usd,
            "output": str(output),
            "at": datetime.now(UTC).isoformat(),
        }
    )
    print(json.dumps(result.__dict__, indent=2, default=str))
    return result


def run_panel(hypothesis: str) -> RunResult:
    _require_openrouter()
    _require_manifest()
    if hypothesis not in PANELS:
        raise SystemExit(f"unknown hypothesis {hypothesis!r}; expected one of {sorted(PANELS)}")
    spent = _ledger_total()
    if spent >= SPEND_CAP_USD:
        raise SystemExit(f"spend cap ${SPEND_CAP_USD:.2f} already reached (${spent:.2f} logged)")

    config = PANELS[hypothesis]
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    output = OUT_DIR / f"{hypothesis}-{stamp}.jsonl"
    report = OUT_DIR / f"{hypothesis}-{stamp}.md"
    result = _public_bench(
        config_rel=config,
        subset=None,
        output=output,
        report=report,
        runner_timeout_s=PANEL_TIMEOUT_S,
    )
    result.hypothesis = hypothesis
    member_rates = _summarize_member_pass_rates(result.raw["run"])  # type: ignore[arg-type]
    best_single = max(member_rates.values()) if member_rates else None
    _append_ledger(
        {
            "phase": "panel",
            "hypothesis": hypothesis,
            "config": config,
            "cost_usd": result.cost_usd,
            "fusion_score": result.fusion_score,
            "passed_tasks": result.passed_tasks,
            "resolved_tasks": result.resolved_tasks,
            "member_pass_rates": member_rates,
            "best_single_pass_rate": best_single,
            "output": str(output),
            "report": str(report),
            "at": datetime.now(UTC).isoformat(),
        }
    )
    print(
        json.dumps(
            {
                "hypothesis": hypothesis,
                "fusion_score": result.fusion_score,
                "passed_tasks": result.passed_tasks,
                "resolved_tasks": result.resolved_tasks,
                "cost_usd": result.cost_usd,
                "member_pass_rates": member_rates,
                "best_single_pass_rate": best_single,
                "ledger_total_usd": _ledger_total(),
                "output": str(output),
                "report": str(report),
            },
            indent=2,
        )
    )
    if _ledger_total() >= SPEND_CAP_USD:
        print(f"warning: spend cap ${SPEND_CAP_USD:.2f} reached", file=sys.stderr)
    return result


def run_all() -> None:
    for hypothesis in ("h1", "h2", "h5"):
        if _ledger_total() >= SPEND_CAP_USD:
            print(f"stopping before {hypothesis}: spend cap reached", file=sys.stderr)
            break
        run_panel(hypothesis)


def run_judge_matrix(
    *,
    parallel: bool = False,
    mimo_only: bool = False,
    gemini_only: bool = False,
) -> None:
    """Run judge-swap panels on the frozen manifest."""
    if mimo_only and gemini_only:
        raise SystemExit("choose at most one of --mimo-only / --gemini-only")
    if mimo_only:
        order = JUDGE_MIMO_ORDER
    elif gemini_only:
        order = JUDGE_GEMINI_ORDER
    else:
        order = JUDGE_MATRIX_ORDER

    if parallel:
        pending = [
            hypothesis
            for hypothesis in order
            if _ledger_total() < SPEND_CAP_USD
        ]
        if not pending:
            print("spend cap reached before judge matrix", file=sys.stderr)
            return
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(pending)) as pool:
            futures = {pool.submit(run_panel, hypothesis): hypothesis for hypothesis in pending}
            for future in concurrent.futures.as_completed(futures):
                hypothesis = futures[future]
                try:
                    future.result()
                except SystemExit as exc:
                    print(f"{hypothesis} failed: {exc}", file=sys.stderr)
        return

    for hypothesis in order:
        if _ledger_total() >= SPEND_CAP_USD:
            print(f"stopping before {hypothesis}: spend cap reached", file=sys.stderr)
            break
        run_panel(hypothesis)


def run_oracle_exp(*, parallel: bool = False, only: str | None = None) -> None:
    """Run the oracle-maximization experiments (e1 solo baseline, e2, e3)."""
    order = (only,) if only else ORACLE_EXP_ORDER

    if parallel:
        pending = [hypothesis for hypothesis in order if _ledger_total() < SPEND_CAP_USD]
        if not pending:
            print("spend cap reached before oracle experiments", file=sys.stderr)
            return
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(pending)) as pool:
            futures = {pool.submit(run_panel, hypothesis): hypothesis for hypothesis in pending}
            for future in concurrent.futures.as_completed(futures):
                hypothesis = futures[future]
                try:
                    future.result()
                except SystemExit as exc:
                    print(f"{hypothesis} failed: {exc}", file=sys.stderr)
        return

    for hypothesis in order:
        if _ledger_total() >= SPEND_CAP_USD:
            print(f"stopping before {hypothesis}: spend cap reached", file=sys.stderr)
            break
        run_panel(hypothesis)


def run_solo_sweep(*, parallel: bool = False, only: str | None = None) -> None:
    """Run solo self-judge/synthesis panels for the error-correlation sweep."""
    order = (only,) if only else SOLO_ORDER

    if parallel:
        pending = [hypothesis for hypothesis in order if _ledger_total() < SPEND_CAP_USD]
        if not pending:
            print("spend cap reached before solo sweep", file=sys.stderr)
            return
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(pending)) as pool:
            futures = {pool.submit(run_panel, hypothesis): hypothesis for hypothesis in pending}
            for future in concurrent.futures.as_completed(futures):
                hypothesis = futures[future]
                try:
                    future.result()
                except SystemExit as exc:
                    print(f"{hypothesis} failed: {exc}", file=sys.stderr)
        return

    for hypothesis in order:
        if _ledger_total() >= SPEND_CAP_USD:
            print(f"stopping before {hypothesis}: spend cap reached", file=sys.stderr)
            break
        run_panel(hypothesis)


def main() -> None:
    parser = argparse.ArgumentParser(description="Phase C benchmark runner")
    sub = parser.add_subparsers(dest="command", required=True)
    pre = sub.add_parser("preflight", help="run 5-task preflight on one panel")
    pre.add_argument("--hypothesis", choices=sorted(PANELS), default="h1")
    run = sub.add_parser("run", help="run full manifest for one panel")
    run.add_argument("--hypothesis", choices=sorted(PANELS), required=True)
    sub.add_parser("run-all", help="run H1, H2, H5 sequentially until spend cap")
    judge = sub.add_parser(
        "run-judge-matrix",
        help="run the six judge-experiment panels (j1-g … j3-m) until spend cap",
    )
    judge.add_argument(
        "--parallel",
        action="store_true",
        help="run all pending judge panels concurrently (separate cache signatures)",
    )
    judge.add_argument(
        "--mimo-only",
        action="store_true",
        help="run only MiMo-judge panels (j1-m, j2-m, j3-m)",
    )
    judge.add_argument(
        "--gemini-only",
        action="store_true",
        help="run only Gemini-judge panels (j1-g, j2-g, j3-g)",
    )
    oracle = sub.add_parser(
        "run-oracle-exp",
        help="run frontier-chase experiments (e1 gpt-5.5 solo, p1-p3 gemini-judge trios)",
    )
    oracle.add_argument(
        "--parallel",
        action="store_true",
        help="run all pending oracle experiments concurrently",
    )
    oracle.add_argument(
        "--only",
        choices=sorted(ORACLE_EXP_PANELS),
        default=None,
        help="run a single oracle experiment",
    )
    solo = sub.add_parser(
        "run-solo-sweep",
        help="run single-model self-judge/synthesis panels until spend cap",
    )
    solo.add_argument(
        "--parallel",
        action="store_true",
        help="run all pending solo panels concurrently",
    )
    solo.add_argument(
        "--only",
        choices=sorted(SOLO_PANELS),
        default=None,
        help="run a single solo panel",
    )
    args = parser.parse_args()

    if args.command == "preflight":
        run_preflight(args.hypothesis)
    elif args.command == "run":
        run_panel(args.hypothesis)
    elif args.command == "run-all":
        run_all()
    elif args.command == "run-judge-matrix":
        run_judge_matrix(
            parallel=args.parallel,
            mimo_only=args.mimo_only,
            gemini_only=args.gemini_only,
        )
    elif args.command == "run-oracle-exp":
        run_oracle_exp(parallel=args.parallel, only=args.only)
    elif args.command == "run-solo-sweep":
        run_solo_sweep(parallel=args.parallel, only=args.only)


if __name__ == "__main__":
    main()
