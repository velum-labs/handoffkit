"""Tier-2 acceptance gate: deep panel (3 samples/member, select-best) vs the
incumbent shallow panel (1 sample/member, rewrite default), paired on the same
dev tasks.

The shallow view is derived from the deep dev bank by keeping only each model's
PRIMARY (first, base-temperature) sample — exactly the candidate pool the
incumbent config would have produced. Judge+synth are replayed for the shallow
view; the deep passes are reloaded from the phase-5 ablation output.

Usage (repo root):
  uv run python audit/20260701-2027/phase5/compare_shallow_deep.py
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

from fusionkit_core.clients import build_clients
from fusionkit_core.config import load_config
from fusionkit_evals.candidate_bank import BankTask, CandidateBank, load_bank
from fusionkit_evals.fusion_hillclimb import best_single_baseline
from fusionkit_evals.prompt_tuning import (
    PromptVariant,
    TunerRuntime,
    evaluate_variant,
    mcnemar,
)
from fusionkit_evals.sandbox import SandboxConfig, build_sandbox

DEEP_BANK = ".fusionkit/hillclimb/dev-bank-deep.json"
DEEP_ABLATIONS = "audit/20260701-2027/phase5/dev-ablations-deep.json"
CONFIG = "configs/benchmark-panel.gpt-opus.yaml"  # incumbent (shallow, rewrite)
OUT = "audit/20260701-2027/phase5/shallow-vs-deep.json"


def shallow_view(bank: CandidateBank) -> CandidateBank:
    tasks = []
    for task in bank.tasks:
        seen: set[str] = set()
        primaries = []
        for cand in task.candidates:
            if cand.model_id in seen:
                continue
            seen.add(cand.model_id)
            primaries.append(cand)
        tasks.append(
            BankTask(
                task_id=task.task_id,
                prompt=task.prompt,
                tests=task.tests,
                difficulty=task.difficulty,
                candidates=primaries,
            )
        )
    return CandidateBank(
        signature=bank.signature + "-shallow", panel_models=bank.panel_models, tasks=tasks
    )


async def main() -> None:
    deep_bank = load_bank(DEEP_BANK)
    shallow = shallow_view(deep_bank)
    config = load_config(CONFIG)
    clients = build_clients(config)
    runtime = TunerRuntime(
        clients=clients,
        judge_id=config.resolved_judge_model,
        synth_id=config.resolved_synthesizer_model,
        bank_signature=shallow.signature,
        sandbox=build_sandbox(SandboxConfig(backend=os.environ.get("BENCH_SANDBOX", "local"))),
        cache_dir=Path(".fusionkit/hillclimb/cache"),
        judge_sampling=config.sampling.model_copy(update={"temperature": 0.0}),
        synth_sampling=config.sampling,
        test_timeout_s=8.0,
        concurrency=int(os.environ.get("ABLATION_CONCURRENCY", "6")),
        select_best=config.synthesis_select_best,  # incumbent default (rewrite)
    )
    print("replaying incumbent shallow panel (rewrite) over dev tasks ...")
    shallow_eval = await evaluate_variant(runtime, PromptVariant(), shallow.tasks)
    print(f"  shallow fused: {shallow_eval.score:.4f}")

    ablations = json.loads(Path(DEEP_ABLATIONS).read_text())
    deep_policy = next(
        p for p in ablations["policies"] if p["policy"] == "judge_pick_verbatim"
    )
    deep_passes = {tid: bool(v) for tid, v in deep_policy["passes"].items()}

    paired_shallow = {
        tid: shallow_eval.passes[tid] for tid in deep_passes if tid in shallow_eval.passes
    }
    paired_deep = {tid: deep_passes[tid] for tid in paired_shallow}
    comparison = mcnemar(paired_shallow, paired_deep)
    best_shallow = best_single_baseline(shallow)

    report = {
        "n": len(paired_shallow),
        "incumbent_shallow_rewrite": {
            "fused_rate": shallow_eval.score,
            "best_single": {
                "model": best_shallow.model_id,
                "rate": best_shallow.pass_rate,
            },
        },
        "candidate_deep_select_best": {
            "fused_rate": sum(paired_deep.values()) / len(paired_deep),
        },
        "deep_vs_shallow_mcnemar": {
            "wins": comparison.wins,
            "losses": comparison.losses,
            "statistic": comparison.statistic,
            "significant": comparison.significant,
        },
        "shallow_passes": shallow_eval.passes,
    }
    Path(OUT).write_text(json.dumps(report, indent=1))
    print(json.dumps({k: v for k, v in report.items() if k != "shallow_passes"}, indent=1))


if __name__ == "__main__":
    asyncio.run(main())
