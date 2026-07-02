"""Phase 6 — full-bank polyglot evaluation of the frozen incumbent (rubric 1.2).

The incumbent configuration (deep panel + select-best) was frozen BEFORE any
polyglot task was ever run, so the whole 103-exercise bank is held-out for it.
Replays the real judge+synthesis over the bank with the per-language test
verifier and reports fused vs best single (primary samples) with McNemar.

Usage: uv run python audit/20260701-2027/phase6/poly_full_eval.py
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

from fusionkit_core.clients import build_clients
from fusionkit_core.config import load_config
from fusionkit_evals.candidate_bank import load_bank
from fusionkit_evals.fusion_hillclimb import best_single_baseline, regret_split
from fusionkit_evals.polyglot import load_polyglot_exercises, polyglot_verifier
from fusionkit_evals.prompt_tuning import (
    PromptVariant,
    TunerRuntime,
    evaluate_variant,
    mcnemar,
)
from fusionkit_evals.sandbox import SandboxConfig, build_sandbox

BANK = ".fusionkit/hillclimb/poly-bank-deep.json"
CONFIG = "configs/benchmark-panel.gpt-opus-deep.yaml"
OUT = "audit/20260701-2027/phase6/poly-full-eval.json"


async def main() -> None:
    bank = load_bank(BANK)
    config = load_config(CONFIG)
    clients = build_clients(config)
    exercises = load_polyglot_exercises(
        Path.home() / ".cache" / "fusionkit-bench" / "polyglot",
        languages=["python", "go", "rust"],
    )
    exercise_map = {exercise.task_id: exercise for exercise in exercises}
    runtime = TunerRuntime(
        clients=clients,
        judge_id=config.resolved_judge_model,
        synth_id=config.resolved_synthesizer_model,
        bank_signature=bank.signature,
        sandbox=build_sandbox(SandboxConfig(backend="local")),
        cache_dir=Path(".fusionkit/hillclimb/cache"),
        judge_sampling=config.sampling.model_copy(update={"temperature": 0.0}),
        synth_sampling=config.sampling,
        test_timeout_s=120.0,
        concurrency=int(os.environ.get("ABLATION_CONCURRENCY", "4")),
        verifier=polyglot_verifier(exercise_map, timeout_s=120.0),
        select_best=config.synthesis_select_best,
    )
    print(f"replaying incumbent over {len(bank.tasks)} polyglot tasks ...")
    evaluation = await evaluate_variant(runtime, PromptVariant(), bank.tasks)
    best = best_single_baseline(bank)
    paired_best = {
        tid: best.pass_map[tid] for tid in evaluation.passes if tid in best.pass_map
    }
    paired_fused = {tid: evaluation.passes[tid] for tid in paired_best}
    comparison = mcnemar(paired_best, paired_fused)
    split = regret_split(bank.tasks, evaluation)
    per_language: dict[str, dict[str, int]] = {}
    by_id = {task.task_id: task for task in bank.tasks}
    for tid, passed in evaluation.passes.items():
        language = (by_id[tid].difficulty or "?") if tid in by_id else "?"
        counts = per_language.setdefault(language, {"n": 0, "fused": 0, "best": 0})
        counts["n"] += 1
        counts["fused"] += 1 if passed else 0
        counts["best"] += 1 if paired_best.get(tid) else 0
    report = {
        "n": evaluation.n,
        "fused_rate": evaluation.score,
        "fused_ci": [evaluation.ci_low, evaluation.ci_high],
        "best_single": {"model": best.model_id, "rate": best.pass_rate},
        "uplift": evaluation.score - best.pass_rate,
        "mcnemar": {
            "wins": comparison.wins,
            "losses": comparison.losses,
            "statistic": comparison.statistic,
            "significant": comparison.significant,
        },
        "regret_split": split.model_dump(mode="json"),
        "per_language": per_language,
        "passes": evaluation.passes,
    }
    Path(OUT).write_text(json.dumps(report, indent=1))
    print(json.dumps({k: v for k, v in report.items() if k != "passes"}, indent=1))


if __name__ == "__main__":
    asyncio.run(main())
