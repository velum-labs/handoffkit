"""Phase 4 ablation battery over the frozen candidate bank (audit 20260701-2027).

Replays synthesis policies over the same frozen candidates (no new panel calls):
  A. LLM-rewrite (shipped default): judge analysis -> synthesizer rewrite.
  B. Judge-pick-verbatim (`synthesis_select_best`): judge analysis -> selected
     candidate returned verbatim (no synth call).
  C. Execution-guided selection (eval-harness SOTA reference): select the bank
     candidate passing the most PUBLIC tests, grade on PRIVATE tests
     (leakage-free, local execution only, $0).

Plus: judge selection accuracy + regret splits (3.1/3.2), leave-one-out member
value from bank flags (2.3), and router-policy comparison (5.1).

Usage (repo root):
  uv run python audit/20260701-2027/phase4/run_ablations.py \
      --bank .fusionkit/hillclimb/bank.json \
      --config configs/benchmark-panel.gpt-opus.yaml \
      --out audit/20260701-2027/phase4/ablations.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path

from fusionkit_core.clients import build_clients
from fusionkit_core.config import load_config
from fusionkit_core.router import HeuristicRouter
from fusionkit_core.types import ChatMessage
from fusionkit_evals.bench_verify import verify_solution
from fusionkit_evals.candidate_bank import BankTask, CandidateBank, load_bank
from fusionkit_evals.code_extract import extract_code
from fusionkit_evals.exec_select import CandidateSample, select_index
from fusionkit_evals.fusion_hillclimb import best_single_baseline, regret_split
from fusionkit_evals.livecodebench_data import decode_public_private, load_problems
from fusionkit_evals.prompt_tuning import (
    PromptEval,
    PromptVariant,
    TunerRuntime,
    evaluate_variant,
    mcnemar,
)
from fusionkit_evals.sandbox import SandboxConfig, build_sandbox


def _runtime(config_path: str, bank: CandidateBank, cache_dir: Path, select_best: bool):
    config = load_config(config_path)
    clients = build_clients(config)
    return TunerRuntime(
        clients=clients,
        judge_id=config.resolved_judge_model,
        synth_id=config.resolved_synthesizer_model,
        bank_signature=bank.signature,
        sandbox=build_sandbox(SandboxConfig(backend=os.environ.get("BENCH_SANDBOX", "local"))),
        cache_dir=cache_dir,
        judge_sampling=config.sampling.model_copy(update={"temperature": 0.0}),
        synth_sampling=config.sampling,
        test_timeout_s=8.0,
        concurrency=int(os.environ.get("ABLATION_CONCURRENCY", "6")),
        select_best=select_best,
    )


def _policy_summary(
    name: str,
    bank: CandidateBank,
    evaluation: PromptEval,
    best_single_passes: dict[str, bool],
) -> dict:
    paired_best = {tid: best_single_passes[tid] for tid in evaluation.passes if tid in best_single_passes}
    paired_fused = {tid: evaluation.passes[tid] for tid in paired_best}
    mc = mcnemar(paired_best, paired_fused)
    split = regret_split(bank.tasks, evaluation)
    return {
        "policy": name,
        "n": evaluation.n,
        "pass_rate": evaluation.score,
        "ci": [evaluation.ci_low, evaluation.ci_high],
        "vs_best_single": {
            "uplift": (sum(paired_fused.values()) - sum(paired_best.values())) / len(paired_best)
            if paired_best
            else None,
            "mcnemar_wins": mc.wins,
            "mcnemar_losses": mc.losses,
            "mcnemar_statistic": mc.statistic,
            "significant": mc.significant,
        },
        "regret_split": split.model_dump(mode="json"),
        "passes": evaluation.passes,
    }


def _exec_select_over_bank(bank: CandidateBank, public_private: dict[str, tuple]) -> dict:
    """Execution-guided selection over the bank's candidates (select on public,
    grade on private). Tasks without a usable public/private split are skipped."""
    sandbox = build_sandbox(SandboxConfig(backend=os.environ.get("BENCH_SANDBOX", "local")))
    passes: dict[str, bool] = {}
    selected_models: dict[str, str] = {}
    fallback_private = 0
    for task in bank.tasks:
        pp = public_private.get(task.task_id)
        if pp is None:
            continue
        public, private = pp
        if not public or not private:
            continue
        if private == public:
            fallback_private += 1  # decode fell back; grading==selection would leak
            continue
        samples = []
        codes = []
        for cand in task.candidates:
            code = extract_code(cand.content).code
            codes.append((cand.model_id, code))
            run = verify_solution(sandbox, code, public, timeout_s=8.0, checker_mode="exact")
            samples.append(
                CandidateSample(
                    model_id=cand.model_id,
                    public_passed=sum(1 for t in run.per_test if t.get("passed")),
                    public_total=len(public),
                    private_pass=False,
                )
            )
        sel = select_index(samples)
        model_id, code = codes[sel]
        graded = verify_solution(sandbox, code, private, timeout_s=8.0, checker_mode="exact")
        passes[task.task_id] = graded.passed
        selected_models[task.task_id] = model_id
    return {
        "passes": passes,
        "selected_models": selected_models,
        "skipped_fallback_private": fallback_private,
    }


def _loo_from_flags(bank: CandidateBank) -> dict:
    """Selection-oracle leave-one-out member value from bank pass flags ($0)."""
    models = sorted({c.model_id for t in bank.tasks for c in t.candidates})
    def oracle(subset: set[str]) -> float:
        hits = sum(
            1
            for t in bank.tasks
            if any(c.passed for c in t.candidates if c.model_id in subset)
        )
        return hits / len(bank.tasks)
    full = oracle(set(models))
    return {
        "full_oracle": full,
        "members": {
            m: {
                "solo_rate": oracle({m}),
                "oracle_without": oracle(set(models) - {m}),
                "marginal_oracle_value": full - oracle(set(models) - {m}),
            }
            for m in models
        },
    }


def _router_comparison(
    bank: CandidateBank,
    rewrite_passes: dict[str, bool],
    best_model: str,
    cost_fused_per_task: float,
    cost_single_per_task: float,
) -> dict:
    """Router vs always-fuse vs never-fuse from bank scores (5.1).

    single = best-single candidate result; fused = rewrite-policy result;
    router = HeuristicRouter's per-task choice between them.
    """
    router = HeuristicRouter()
    single_passes = {
        t.task_id: next((c.passed for c in t.candidates if c.model_id == best_model), False)
        for t in bank.tasks
    }
    routed_passes: dict[str, bool] = {}
    routed_fused = 0
    for task in bank.tasks:
        decision = router.route([ChatMessage(role="user", content=task.prompt)])
        if decision.route in ("panel", "self"):
            routed_fused += 1
            routed_passes[task.task_id] = rewrite_passes.get(task.task_id, False)
        else:
            routed_passes[task.task_id] = single_passes[task.task_id]
    n = len(bank.tasks)
    def rate(passes: dict[str, bool]) -> float:
        return sum(1 for v in passes.values() if v) / n
    return {
        "never_fuse": {"pass_rate": rate(single_passes), "cost_per_task": cost_single_per_task},
        "always_fuse": {"pass_rate": rate(rewrite_passes), "cost_per_task": cost_fused_per_task},
        "heuristic_router": {
            "pass_rate": rate(routed_passes),
            "fused_fraction": routed_fused / n,
            "cost_per_task": (
                routed_fused * cost_fused_per_task + (n - routed_fused) * cost_single_per_task
            )
            / n,
        },
    }


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bank", default=".fusionkit/hillclimb/bank.json")
    parser.add_argument("--config", default="configs/benchmark-panel.gpt-opus.yaml")
    parser.add_argument("--cache-dir", default=".fusionkit/hillclimb/cache")
    parser.add_argument("--out", default="audit/20260701-2027/phase4/ablations.json")
    args = parser.parse_args()

    bank = load_bank(args.bank)
    best = best_single_baseline(bank)
    print(f"bank: {len(bank.tasks)} tasks; best single {best.model_id} {best.pass_rate:.4f}")

    # Public/private splits straight from the dataset for exec-select.
    problems = load_problems(10000)
    public_private = {
        str(p["question_id"]): decode_public_private(p, 0)
        for p in problems
        if str(p["question_id"]) in {t.task_id for t in bank.tasks}
    }

    variant = PromptVariant()
    rewrite_runtime = _runtime(args.config, bank, Path(args.cache_dir), select_best=False)
    select_runtime = _runtime(args.config, bank, Path(args.cache_dir), select_best=True)

    print("replaying LLM-rewrite policy over the full bank ...")
    rewrite_eval = await evaluate_variant(rewrite_runtime, variant, bank.tasks)
    print(f"  rewrite pass rate: {rewrite_eval.score:.4f}")
    print("replaying judge-pick-verbatim (select-best) policy ...")
    select_eval = await evaluate_variant(select_runtime, variant, bank.tasks)
    print(f"  select-best pass rate: {select_eval.score:.4f}")

    print("running execution-guided selection over bank candidates (local) ...")
    exec_result = await asyncio.to_thread(_exec_select_over_bank, bank, public_private)
    exec_passes = exec_result["passes"]
    exec_n = len(exec_passes)
    exec_rate = sum(1 for v in exec_passes.values() if v) / exec_n if exec_n else 0.0
    paired_best = {tid: best.pass_map[tid] for tid in exec_passes if tid in best.pass_map}
    exec_mc = mcnemar(paired_best, {tid: exec_passes[tid] for tid in paired_best})
    print(f"  exec-select pass rate: {exec_rate:.4f} over {exec_n} gradeable tasks")

    # Synthesis regression rate (4.2): tasks where the judge picked a passing
    # candidate but the rewrite output failed.
    regressions = [
        tid
        for tid, res in rewrite_eval.task_results.items()
        if res.judge_pick_passed is True and not res.passed
    ]
    rescues = [
        tid
        for tid, res in rewrite_eval.task_results.items()
        if res.judge_pick_passed is False and res.passed
    ]
    both_fail_rescues = [
        tid
        for tid, res in rewrite_eval.task_results.items()
        if res.passed
        and not any(
            c.passed
            for t in bank.tasks
            if t.task_id == tid
            for c in t.candidates
        )
    ]

    report = {
        "bank_signature": bank.signature,
        "n_tasks": len(bank.tasks),
        "best_single": {"model": best.model_id, "pass_rate": best.pass_rate},
        "policies": [
            _policy_summary("llm_rewrite", bank, rewrite_eval, best.pass_map),
            _policy_summary("judge_pick_verbatim", bank, select_eval, best.pass_map),
            {
                "policy": "exec_select_public_private",
                "n": exec_n,
                "pass_rate": exec_rate,
                "vs_best_single": {
                    "uplift": exec_rate
                    - (sum(paired_best.values()) / len(paired_best) if paired_best else 0.0),
                    "mcnemar_wins": exec_mc.wins,
                    "mcnemar_losses": exec_mc.losses,
                    "mcnemar_statistic": exec_mc.statistic,
                    "significant": exec_mc.significant,
                },
                "skipped_fallback_private": exec_result["skipped_fallback_private"],
                "selected_model_counts": {
                    m: sum(1 for v in exec_result["selected_models"].values() if v == m)
                    for m in sorted(set(exec_result["selected_models"].values()))
                },
                "passes": exec_passes,
            },
        ],
        "synthesis_regressions_4_2": {
            "picked_pass_rewrite_fail": regressions,
            "rate_over_picked_pass": (
                len(regressions)
                / max(
                    1,
                    sum(
                        1
                        for r in rewrite_eval.task_results.values()
                        if r.judge_pick_passed is True
                    ),
                )
            ),
            "picked_fail_rewrite_pass": rescues,
            "rewrite_pass_where_all_candidates_failed": both_fail_rescues,
        },
        "leave_one_out_2_3": _loo_from_flags(bank),
        "router_5_1": _router_comparison(
            bank,
            rewrite_eval.passes,
            best.model_id,
            cost_fused_per_task=0.17,
            cost_single_per_task=0.036,
        ),
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=1))
    print(f"wrote {out}")


if __name__ == "__main__":
    asyncio.run(main())
