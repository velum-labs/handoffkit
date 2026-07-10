from __future__ import annotations

import argparse
import asyncio
import csv
import hashlib
import json
import math
import sys
from collections import defaultdict
from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from datasets import load_dataset  # pyright: ignore[reportMissingImports]
from fusionkit_core.clients import ChatClient, build_clients
from fusionkit_core.config import CostMetadata, FusionConfig, ModelEndpoint, SamplingConfig
from fusionkit_core.fusion import FusionEngine
from fusionkit_core.providers import estimate_cost
from fusionkit_core.types import ChatMessage, ModelResponse, StreamChunk
from fusionkit_evals.bench_verify import verify_solution
from fusionkit_evals.candidate_bank import BankCandidate, BankTask, CandidateBank, save_bank
from fusionkit_evals.code_extract import extract_code
from fusionkit_evals.livecodebench_data import LCB_PROMPT_SUFFIX, prepare_tasks
from fusionkit_evals.prompt_tuning import PromptVariant, TunerRuntime, evaluate_variant
from fusionkit_evals.sandbox import LocalSandbox
from hyperkit.stats import clustered_bootstrap_statistic, wilson_interval

ROOT = Path(__file__).resolve().parents[3]
PHASE0 = ROOT / "analysis" / "phase0"
CACHE = PHASE0 / "cache"
DEFAULT_LEDGER = PHASE0 / "c3_spend_ledger.jsonl"
DEFAULT_OUTCOMES = PHASE0 / "c3_outcomes.csv"
DEFAULT_TASKS = PHASE0 / "c3_task_manifest.json"
DEFAULT_BANK = CACHE / "c3_candidate_bank.json"
DEFAULT_CAPTURE = PHASE0 / "c3_capture_p1.json"
DEFAULT_REPORT = PHASE0 / "c3_transfer_report.md"

PANELS: dict[str, list[str]] = {
    "P1_public_complementarity": ["qwen3", "deepseek", "kimi"],
    "P2_top_public_average": ["gpt55", "sonnet", "deepseek"],
    "P3_product_default_restricted": ["kimi", "qwen3", "deepseek"],
}

PUBLIC_MODEL_FILES: dict[str, str] = {
    "gpt55": "gpt-5/livecodebench-test-gpt-5-20251013_115531.json",
    "sonnet": "claude-sonnet-4/livecodebench-test-claude-sonnet-4-20251013_031811.json",
    "kimi": "kimi-k2-0905/livecodebench-test-kimi-k2-0905-20251017_155822.json",
    "deepseek": (
        "deepseek-v3.1-terminus/"
        "livecodebench-test-deepseek-v3.1-terminus-20251024_102915.json"
    ),
    "qwen3": "Qwen3-8B/livecodebench-test-Qwen3-8B-20251002_155958.json",
}


@dataclass(frozen=True)
class EndpointSpec:
    endpoint_id: str
    provider: str
    model: str
    base_url: str
    key_env: str
    input_price: float | None
    output_price: float | None
    max_context: int | None = None


MODEL_SPECS: dict[str, EndpointSpec] = {
    "gpt55": EndpointSpec(
        "gpt55", "openai", "gpt-5.5", "https://api.openai.com", "OPENAI_API_KEY", 1.25, 10.0
    ),
    "sonnet": EndpointSpec(
        "sonnet",
        "anthropic",
        "claude-sonnet-4-6",
        "https://api.anthropic.com",
        "ANTHROPIC_API_KEY",
        3.0,
        15.0,
    ),
    "kimi": EndpointSpec(
        "kimi",
        "openrouter",
        "moonshotai/kimi-k2-thinking",
        "https://openrouter.ai/api",
        "OPENROUTER_API_KEY",
        0.60,
        2.50,
    ),
    "deepseek": EndpointSpec(
        "deepseek",
        "openrouter",
        "deepseek/deepseek-chat",
        "https://openrouter.ai/api",
        "OPENROUTER_API_KEY",
        0.2002,
        0.8001,
    ),
    "qwen3": EndpointSpec(
        "qwen3",
        "openrouter",
        "qwen/qwen3-coder",
        "https://openrouter.ai/api",
        "OPENROUTER_API_KEY",
        0.22,
        1.80,
    ),
}


class CostTrackingClient:
    def __init__(self, client: ChatClient, endpoint: ModelEndpoint) -> None:
        self._client = client
        self._endpoint = endpoint
        self.model_id = client.model_id
        self.max_context = client.max_context
        self.records: list[dict[str, Any]] = []

    async def chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[Mapping[str, Any]] | None = None,
        tool_choice: str | Mapping[str, Any] | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> ModelResponse:
        response = await self._client.chat(
            messages,
            sampling,
            tools=tools,
            tool_choice=tool_choice,
            extra=extra,
        )
        self.records.append(cost_record(self._endpoint, response=response))
        return response

    def stream_chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[Mapping[str, Any]] | None = None,
        tool_choice: str | Mapping[str, Any] | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> AsyncIterator[StreamChunk]:
        return self._client.stream_chat(
            messages,
            sampling,
            tools=tools,
            tool_choice=tool_choice,
            extra=extra,
        )

    async def aclose(self) -> None:
        await self._client.aclose()


def model_specs(model_ids: Sequence[str], *, sonnet_model: str | None = None) -> list[EndpointSpec]:
    specs = []
    for model_id in model_ids:
        spec = MODEL_SPECS[model_id]
        if model_id == "sonnet" and sonnet_model:
            spec = EndpointSpec(
                spec.endpoint_id,
                spec.provider,
                sonnet_model,
                spec.base_url,
                spec.key_env,
                spec.input_price,
                spec.output_price,
                spec.max_context,
            )
        specs.append(spec)
    return specs


def fusion_config(
    specs: Sequence[EndpointSpec],
    *,
    max_tokens: int,
    request_timeout_s: float = 180.0,
) -> FusionConfig:
    endpoints = [
        ModelEndpoint(
            id=spec.endpoint_id,
            provider=spec.provider,
            model=spec.model,
            base_url=spec.base_url,
            api_key_env=spec.key_env,
            pricing=CostMetadata(
                input_per_1m_tokens=spec.input_price,
                output_per_1m_tokens=spec.output_price,
            ),
            max_context=spec.max_context,
            timeout_s=request_timeout_s,
        )
        for spec in specs
    ]
    return FusionConfig(
        endpoints=endpoints,
        default_model=endpoints[0].id,
        judge_model=endpoints[0].id,
        synthesizer_model=endpoints[0].id,
        default_mode="panel",
        panel_models=[endpoint.id for endpoint in endpoints],
        sampling=SamplingConfig(temperature=0.2, top_p=0.95, max_tokens=max_tokens),
    )


def endpoint_by_id(config: FusionConfig) -> dict[str, ModelEndpoint]:
    return {endpoint.id: endpoint for endpoint in config.endpoints}


def cost_record(
    endpoint: ModelEndpoint,
    *,
    response: ModelResponse | None = None,
    trajectory: Any | None = None,
) -> dict[str, Any]:
    usage = None
    provider_cost = None
    latency_s = None
    finish_reason = None
    if response is not None:
        usage = response.usage.model_dump(mode="json")
        provider_cost = (
            response.provider_cost.model_dump(mode="json", exclude_none=True)
            if response.provider_cost is not None
            else None
        )
        latency_s = response.latency_s
        finish_reason = response.finish_reason
    if trajectory is not None:
        metadata = trajectory.metadata or {}
        usage = metadata.get("usage")
        provider_cost = metadata.get("provider_cost")
        latency_s = metadata.get("latency_s")
        finish_reason = metadata.get("finish_reason")
    exact = None
    if isinstance(provider_cost, Mapping):
        raw_exact = provider_cost.get("cost_usd")
        if isinstance(raw_exact, int | float):
            exact = float(raw_exact)
    estimated = estimate_cost(endpoint, usage if isinstance(usage, Mapping) else None)
    return {
        "endpoint_id": endpoint.id,
        "provider": endpoint.provider,
        "model": endpoint.model,
        "prompt_tokens": _num(usage, "prompt_tokens"),
        "completion_tokens": _num(usage, "completion_tokens"),
        "total_tokens": _num(usage, "total_tokens"),
        "estimated_cost_usd": estimated,
        "provider_cost_usd": exact,
        "charged_cost_usd": exact if exact is not None else estimated,
        "latency_s": latency_s,
        "finish_reason": finish_reason,
        "provider_cost": provider_cost,
    }


def _num(payload: object, key: str) -> int | None:
    if isinstance(payload, Mapping):
        value = payload.get(key)
        if isinstance(value, int):
            return value
    return None


def write_ledger(path: Path, rows: Sequence[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, sort_keys=True) + "\n")


def load_ledger(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def total_spend(path: Path) -> float:
    total = 0.0
    for row in load_ledger(path):
        value = row.get("charged_cost_usd")
        if isinstance(value, int | float):
            total += float(value)
            continue
        fallback = estimate_row_cost(row)
        if fallback is not None:
            total += fallback
    return total


def estimate_row_cost(row: Mapping[str, Any]) -> float | None:
    model = row.get("model")
    spec = next((item for item in MODEL_SPECS.values() if item.model == model), None)
    if spec is None or spec.input_price is None or spec.output_price is None:
        return None
    prompt_tokens = row.get("prompt_tokens")
    completion_tokens = row.get("completion_tokens")
    if not isinstance(prompt_tokens, int) or not isinstance(completion_tokens, int):
        return None
    return (
        prompt_tokens * spec.input_price / 1_000_000
        + completion_tokens * spec.output_price / 1_000_000
    )


def selected_problem_rows(
    subset: int,
    *,
    min_date: str,
    version: str,
    max_tasks: int | None = None,
) -> list[dict[str, Any]]:
    # The repo's in-memory loader OOMs in this VM after materializing the split.
    # Keep its selection semantics, but stream rows and still use prepare_tasks /
    # decode_tests from fusionkit_evals.livecodebench_data for prompt/test shape.
    rows = load_dataset(
        "livecodebench/code_generation_lite",
        split="test",
        version_tag=version,
        trust_remote_code=True,
        streaming=True,
    )
    selected = []
    for row in rows:
        if (row.get("difficulty") or "").lower() not in {"medium", "hard"}:
            continue
        if str(row.get("contest_date") or "") < min_date:
            continue
        try:
            public = json.loads(row["public_test_cases"])
        except (KeyError, json.JSONDecodeError, TypeError):
            continue
        if any(test.get("testtype") != "stdin" for test in public):
            continue
        if row.get("starter_code"):
            continue
        selected.append(dict(row))
    selected.sort(key=lambda problem: str(problem.get("contest_date")), reverse=True)
    limit = max_tasks if max_tasks is not None else subset
    return selected[:limit]


def write_task_manifest(path: Path, problems: Sequence[Mapping[str, Any]], *, version: str) -> None:
    rows = []
    for problem in problems:
        task_id = str(problem.get("question_id"))
        rows.append(
            {
                "task_id": task_id,
                "question_id": task_id,
                "contest_date": str(problem.get("contest_date") or ""),
                "cluster_key": str(problem.get("contest_date") or task_id),
                "difficulty": str(problem.get("difficulty") or ""),
                "version": version,
            }
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"version": version, "tasks": rows}, indent=2), encoding="utf-8")


def read_task_manifest(path: Path) -> dict[str, dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return {str(row["task_id"]): row for row in data["tasks"]}


def read_task_manifest_ids(path: Path) -> list[str]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return [str(row["task_id"]) for row in data["tasks"]]


def prepared_tasks_from_bank(
    path: Path,
    *,
    manifest: Path,
    subset: int,
) -> list[dict[str, Any]]:
    bank = CandidateBank.model_validate_json(path.read_text(encoding="utf-8"))
    bank_ids = [task.task_id for task in bank.tasks]
    manifest_ids = read_task_manifest_ids(manifest)
    if bank_ids != manifest_ids:
        raise ValueError(
            f"source bank task ids do not match manifest: {len(bank_ids)} bank ids, "
            f"{len(manifest_ids)} manifest ids"
        )
    return [
        {
            "task_id": task.task_id,
            "prompt": task.prompt,
            "tests": task.tests,
            "difficulty": task.difficulty,
        }
        for task in bank.tasks[:subset]
    ]


async def provider_smoke(args: argparse.Namespace) -> int:
    specs = model_specs(args.models.split(","), sonnet_model=args.sonnet_model)
    config = fusion_config(specs, max_tokens=16, request_timeout_s=args.request_timeout_s)
    clients = build_clients(config)
    endpoints = endpoint_by_id(config)
    rows = []
    failures = 0
    for model_id in config.panel_models:
        endpoint = endpoints[model_id]
        try:
            response = await clients[model_id].chat(
                [ChatMessage(role="user", content="Reply with exactly: OK")],
                SamplingConfig(temperature=0.0, top_p=1.0, max_tokens=16),
            )
            row = {
                "phase": args.phase,
                "task_id": "provider_smoke",
                "status": "succeeded",
                **cost_record(endpoint, response=response),
            }
        except Exception as exc:
            failures += 1
            row = {
                "phase": args.phase,
                "task_id": "provider_smoke",
                "endpoint_id": model_id,
                "provider": endpoint.provider,
                "model": endpoint.model,
                "status": "failed",
                "error_message": str(exc)[:1000],
                "charged_cost_usd": 0.0,
            }
        rows.append(row)
    write_ledger(args.ledger, rows)
    print(
        json.dumps(
            {"models": len(config.panel_models), "failures": failures, "ledger": str(args.ledger)}
        )
    )
    return 1 if failures else 0


async def build_bank(args: argparse.Namespace) -> int:
    specs = model_specs(args.models.split(","), sonnet_model=args.sonnet_model)
    config = fusion_config(
        specs,
        max_tokens=args.max_tokens,
        request_timeout_s=args.request_timeout_s,
    )
    clients = build_clients(config)
    engine = FusionEngine(config, clients)
    endpoints = endpoint_by_id(config)
    sandbox = LocalSandbox()
    if args.source_bank is not None:
        prepared = prepared_tasks_from_bank(args.source_bank, manifest=args.tasks, subset=args.subset)
    else:
        problems = selected_problem_rows(args.subset, min_date=args.min_date, version=args.version)
        write_task_manifest(args.tasks, problems, version=args.version)
        prepared = prepare_tasks(problems, max_tests=args.max_tests)
    signature = hashlib.sha256(
        json.dumps(
            {
                "models": [(spec.endpoint_id, spec.provider, spec.model) for spec in specs],
                "tasks": [task["task_id"] for task in prepared],
                "prompt_suffix": LCB_PROMPT_SUFFIX,
            },
            sort_keys=True,
        ).encode()
    ).hexdigest()[:16]
    bank_tasks = []
    outcome_rows = []
    ledger_rows = []
    task_meta = read_task_manifest(args.tasks)
    cumulative_start = total_spend(args.ledger)
    observed_task_costs: list[float] = []
    for index, task in enumerate(prepared, start=1):
        if observed_task_costs:
            projected_next = cumulative_start + sum(observed_task_costs) + (
                sum(observed_task_costs) / len(observed_task_costs)
            )
            if projected_next > args.budget_usd:
                print(
                    f"stopping before task {index}: projected ${projected_next:.4f} "
                    f"exceeds ${args.budget_usd:.2f}",
                    file=sys.stderr,
                )
                break
        trajectories = await engine.producer.generate_panel(
            config.panel_models,
            [ChatMessage(role="user", content=task["prompt"])],
            config.sampling,
        )
        bank_candidates = []
        task_cost = 0.0
        for trajectory in trajectories:
            endpoint = endpoints[trajectory.model_id]
            cost = cost_record(endpoint, trajectory=trajectory)
            charged = cost.get("charged_cost_usd")
            if isinstance(charged, int | float):
                task_cost += float(charged)
            status = trajectory.status
            error_message = ""
            passed = False
            if status == "succeeded":
                code = extract_code(trajectory.content).code
                run = verify_solution(
                    sandbox,
                    code,
                    task["tests"],
                    timeout_s=args.test_timeout_s,
                )
                passed = run.passed
            else:
                error_message = str(trajectory.metadata.get("error_message") or "")[:1000]
            bank_candidates.append(
                BankCandidate(
                    model_id=trajectory.model_id,
                    content=trajectory.content,
                    passed=passed,
                )
            )
            meta = task_meta[str(task["task_id"])]
            outcome_rows.append(
                {
                    "task_id": task["task_id"],
                    "cluster_key": meta["cluster_key"],
                    "contest_date": meta["contest_date"],
                    "difficulty": task.get("difficulty") or "",
                    "endpoint_id": trajectory.model_id,
                    "provider": endpoint.provider,
                    "model": endpoint.model,
                    "call_status": status,
                    "passed": int(passed),
                    "error_message": error_message,
                    **{key: cost.get(key) for key in (
                        "prompt_tokens",
                        "completion_tokens",
                        "total_tokens",
                        "estimated_cost_usd",
                        "provider_cost_usd",
                        "charged_cost_usd",
                        "latency_s",
                    )},
                }
            )
            ledger_rows.append(
                {
                    "phase": args.phase,
                    "task_id": task["task_id"],
                    "status": status,
                    "error_message": error_message,
                    **cost,
                }
            )
        observed_task_costs.append(task_cost)
        bank_tasks.append(
            BankTask(
                task_id=str(task["task_id"]),
                prompt=task["prompt"],
                tests=task["tests"],
                difficulty=task.get("difficulty"),
                candidates=bank_candidates,
            )
        )
        print(
            f"{args.phase}: task {index}/{len(prepared)} {task['task_id']} cost=${task_cost:.4f}",
            file=sys.stderr,
            flush=True,
        )
    bank = CandidateBank(signature=signature, panel_models=config.panel_models, tasks=bank_tasks)
    save_bank(args.bank, bank)
    write_outcomes(args.outcomes, outcome_rows)
    write_ledger(args.ledger, ledger_rows)
    print(
        json.dumps(
            {
                "bank": str(args.bank),
                "tasks": len(bank.tasks),
                "models": config.panel_models,
                "phase_cost_usd": sum(
                    float(row["charged_cost_usd"])
                    for row in ledger_rows
                    if isinstance(row.get("charged_cost_usd"), int | float)
                ),
                "cumulative_cost_usd": total_spend(args.ledger),
            },
            sort_keys=True,
        )
    )
    return 0


def write_outcomes(path: Path, rows: Sequence[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "task_id",
        "cluster_key",
        "contest_date",
        "difficulty",
        "endpoint_id",
        "provider",
        "model",
        "call_status",
        "passed",
        "prompt_tokens",
        "completion_tokens",
        "total_tokens",
        "estimated_cost_usd",
        "provider_cost_usd",
        "charged_cost_usd",
        "latency_s",
        "error_message",
    ]
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def read_outcomes(path: Path) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def analyze(args: argparse.Namespace) -> int:
    outcomes = read_outcomes(args.outcomes)
    capture = (
        json.loads(args.capture.read_text(encoding="utf-8")) if args.capture.exists() else None
    )
    metrics = compute_metrics(outcomes, capture=capture, ledger=args.ledger)
    args.metrics_json.write_text(json.dumps(metrics, indent=2, sort_keys=True), encoding="utf-8")
    args.report.write_text(format_report(metrics), encoding="utf-8")
    print(
        json.dumps(
            {"report": str(args.report), "metrics": str(args.metrics_json)},
            sort_keys=True,
        )
    )
    return 0


def compute_metrics(
    outcomes: Sequence[Mapping[str, Any]],
    *,
    capture: Mapping[str, Any] | None,
    ledger: Path,
) -> dict[str, Any]:
    by_model: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    by_task: dict[str, dict[str, Mapping[str, Any]]] = defaultdict(dict)
    for row in outcomes:
        by_model[str(row["endpoint_id"])].append(row)
        by_task[str(row["task_id"])][str(row["endpoint_id"])] = row
    per_model = []
    for model_id in sorted(by_model):
        succeeded = [row for row in by_model[model_id] if row["call_status"] == "succeeded"]
        successes = sum(int(row["passed"]) for row in succeeded)
        ci = wilson_interval(successes, len(succeeded))
        first = by_model[model_id][0]
        per_model.append(
            {
                "endpoint_id": model_id,
                "provider": first["provider"],
                "model": first["model"],
                "n": len(succeeded),
                "successes": successes,
                "pass_rate": ci.estimate,
                "ci_low": ci.low,
                "ci_high": ci.high,
                "provider_failures": len(by_model[model_id]) - len(succeeded),
            }
        )
    panels = []
    for panel_id, members in PANELS.items():
        panels.append(panel_metrics(panel_id, members, by_task))
    calibrated_pairs = pairwise_calibrated(by_task)
    public_pairs = pairwise_public()
    sign_rows = []
    for pair_key in sorted(set(calibrated_pairs) & set(public_pairs)):
        calibrated = calibrated_pairs[pair_key]
        public = public_pairs[pair_key]
        sign_rows.append(
            {
                "pair": pair_key,
                "public_phi": public["phi"],
                "public_sign": public["sign"],
                "public_n": public["n"],
                "calibrated_phi": calibrated["phi"],
                "calibrated_sign": calibrated["sign"],
                "calibrated_n": calibrated["n"],
                "agreement": public["sign"] == calibrated["sign"],
                "mapping_note": public["mapping_note"],
            }
        )
    total_pairs = len(sign_rows)
    agreed = sum(1 for row in sign_rows if row["agreement"])
    headroom_pass = any(panel["headroom"] >= 0.05 for panel in panels)
    sign_pass = total_pairs > 0 and agreed == total_pairs
    return {
        "per_model": per_model,
        "panels": panels,
        "sign_agreement": {
            "rows": sign_rows,
            "agreed": agreed,
            "total": total_pairs,
            "passes": sign_pass,
        },
        "capture": capture,
        "total_spend_usd": total_spend(ledger),
        "verdict": "PASS" if headroom_pass and sign_pass else "FAIL",
        "headroom_pass": headroom_pass,
    }


def panel_metrics(
    panel_id: str,
    members: Sequence[str],
    by_task: Mapping[str, Mapping[str, Mapping[str, Any]]],
) -> dict[str, Any]:
    common_task_ids = [
        task_id
        for task_id, rows in by_task.items()
        if all(member in rows and rows[member]["call_status"] == "succeeded" for member in members)
    ]
    member_rates = {}
    for member in members:
        values = [int(by_task[task_id][member]["passed"]) for task_id in common_task_ids]
        member_rates[member] = sum(values) / len(values) if values else 0.0
    oracle_hits = [
        max(int(by_task[task_id][member]["passed"]) for member in members)
        for task_id in common_task_ids
    ]
    oracle = sum(oracle_hits) / len(oracle_hits) if oracle_hits else 0.0
    best = max(member_rates.values()) if member_rates else 0.0
    headroom = oracle - best
    ci = clustered_bootstrap_panel(members, by_task, common_task_ids)
    return {
        "panel_id": panel_id,
        "members": list(members),
        "n": len(common_task_ids),
        "member_rates": member_rates,
        "best_single": best,
        "oracle": oracle,
        "headroom": headroom,
        "oracle_ci_low": ci["oracle"][0],
        "oracle_ci_high": ci["oracle"][1],
        "headroom_ci_low": ci["headroom"][0],
        "headroom_ci_high": ci["headroom"][1],
    }


def clustered_bootstrap_panel(
    members: Sequence[str],
    by_task: Mapping[str, Mapping[str, Mapping[str, Any]]],
    task_ids: Sequence[str],
    *,
    iterations: int = 1000,
    seed: int = 0,
) -> dict[str, tuple[float, float]]:
    clusters: dict[str, list[str]] = defaultdict(list)
    for task_id in task_ids:
        cluster = str(by_task[task_id][members[0]].get("cluster_key") or task_id)
        clusters[cluster].append(task_id)
    if not clusters:
        return {"oracle": (0.0, 0.0), "headroom": (0.0, 0.0)}

    def metrics(sampled: Sequence[str]) -> tuple[float, float]:
        member_rates = []
        for member in members:
            vals = [int(by_task[task_id][member]["passed"]) for task_id in sampled]
            member_rates.append(sum(vals) / len(vals))
        oracle_hits = [
            max(int(by_task[task_id][member]["passed"]) for member in members)
            for task_id in sampled
        ]
        oracle = sum(oracle_hits) / len(oracle_hits)
        return oracle, oracle - max(member_rates)

    oracle_ci = clustered_bootstrap_statistic(
        clusters,
        lambda sampled: metrics(sampled)[0],
        iterations=iterations,
        seed=seed,
    )
    headroom_ci = clustered_bootstrap_statistic(
        clusters,
        lambda sampled: metrics(sampled)[1],
        iterations=iterations,
        seed=seed,
    )
    return {"oracle": oracle_ci, "headroom": headroom_ci}


def pairwise_calibrated(
    by_task: Mapping[str, Mapping[str, Mapping[str, Any]]],
) -> dict[str, dict[str, Any]]:
    out = {}
    models = sorted(MODEL_SPECS)
    for left_index, left in enumerate(models):
        for right in models[left_index + 1 :]:
            pairs = []
            for rows in by_task.values():
                if (
                    left in rows
                    and right in rows
                    and rows[left]["call_status"] == "succeeded"
                    and rows[right]["call_status"] == "succeeded"
                ):
                    pairs.append((1 - int(rows[left]["passed"]), 1 - int(rows[right]["passed"])))
            phi = phi_from_pairs(pairs)
            out[pair_key(left, right)] = {"phi": phi, "sign": sign(phi), "n": len(pairs)}
    return out


def pairwise_public() -> dict[str, dict[str, Any]]:
    base = CACHE / "llmrouterbench_coding" / "bench-release" / "livecodebench" / "test"
    model_scores = {}
    for model_id, relpath in PUBLIC_MODEL_FILES.items():
        path = base / relpath
        if not path.exists():
            continue
        payload = json.loads(path.read_text(encoding="utf-8"))
        scores = {}
        for record in payload.get("records", []):
            scores[str(record["index"])] = int(float(record.get("score") or 0.0) >= 1.0)
        model_scores[model_id] = scores
    out = {}
    models = sorted(model_scores)
    for left_index, left in enumerate(models):
        for right in models[left_index + 1 :]:
            common = sorted(set(model_scores[left]) & set(model_scores[right]))
            pairs = [
                (1 - model_scores[left][task_id], 1 - model_scores[right][task_id])
                for task_id in common
            ]
            phi = phi_from_pairs(pairs)
            out[pair_key(left, right)] = {
                "phi": phi,
                "sign": sign(phi),
                "n": len(pairs),
                "mapping_note": public_mapping_note(left, right),
            }
    return out


def phi_from_pairs(pairs: Sequence[tuple[int, int]]) -> float | None:
    if len(pairs) < 2:
        return None
    xs = [pair[0] for pair in pairs]
    ys = [pair[1] for pair in pairs]
    mean_x = sum(xs) / len(xs)
    mean_y = sum(ys) / len(ys)
    numerator = sum((x - mean_x) * (y - mean_y) for x, y in pairs)
    denom_x = math.sqrt(sum((x - mean_x) ** 2 for x in xs))
    denom_y = math.sqrt(sum((y - mean_y) ** 2 for y in ys))
    if denom_x == 0 or denom_y == 0:
        return None
    return numerator / (denom_x * denom_y)


def sign(value: float | None) -> str:
    if value is None:
        return "undefined"
    if value > 0.05:
        return "positive"
    if value < -0.05:
        return "negative"
    return "near-zero"


def pair_key(left: str, right: str) -> str:
    return " / ".join(sorted([left, right]))


def public_mapping_note(left: str, right: str) -> str:
    notes = {
        "gpt55": "public gpt-5 vs calibrated gpt-5.5",
        "sonnet": "public claude-sonnet-4 vs calibrated claude-sonnet-4-6",
        "kimi": "public kimi-k2-0905 vs calibrated kimi-k2-thinking",
        "deepseek": "public deepseek-v3.1-terminus vs calibrated deepseek-chat",
        "qwen3": "public Qwen3-8B vs calibrated qwen3-coder",
    }
    return f"{notes[left]}; {notes[right]}"


async def capture(args: argparse.Namespace) -> int:
    bank = CandidateBank.model_validate_json(args.bank.read_text(encoding="utf-8"))
    outcomes = read_outcomes(args.outcomes)
    panel_members = PANELS[args.panel_id]
    succeeded = {
        row["task_id"]
        for row in outcomes
        if row["endpoint_id"] in panel_members
        and row["call_status"] == "succeeded"
    }
    counts = defaultdict(int)
    for row in outcomes:
        if (
            row["endpoint_id"] in panel_members
            and row["call_status"] == "succeeded"
        ):
            counts[row["task_id"]] += 1
    task_ids = {task_id for task_id in succeeded if counts[task_id] == len(panel_members)}
    tasks = [
        task.model_copy(
            update={
                "candidates": [
                    candidate
                    for candidate in task.candidates
                    if candidate.model_id in panel_members
                ]
            }
        )
        for task in bank.tasks
        if task.task_id in task_ids
    ]
    replay_models = list(panel_members)
    if args.judge_id not in replay_models:
        replay_models.append(args.judge_id)
    specs = model_specs(replay_models, sonnet_model=args.sonnet_model)
    config = fusion_config(
        specs,
        max_tokens=args.max_tokens,
        request_timeout_s=args.request_timeout_s,
    )
    clients = build_clients(config)
    tracked = {
        model_id: CostTrackingClient(clients[model_id], config.endpoint_for(model_id))
        for model_id in clients
    }
    runtime = TunerRuntime(
        clients=tracked,
        judge_id=args.judge_id,
        synth_id=args.judge_id,
        bank_signature=bank.signature,
        sandbox=LocalSandbox(),
        cache_dir=args.cache_dir,
        judge_sampling=config.sampling.model_copy(update={"temperature": 0.0}),
        synth_sampling=config.sampling,
        test_timeout_s=args.test_timeout_s,
        concurrency=args.concurrency,
        select_best=True,
    )
    evaluation = await evaluate_variant(runtime, PromptVariant(), tasks)
    ledger_rows = []
    for client in tracked.values():
        for record in client.records:
            ledger_rows.append(
                {
                    "phase": args.phase,
                    "task_id": "capture_replay",
                    "status": "succeeded",
                    **record,
                }
            )
    write_ledger(args.ledger, ledger_rows)
    best = 0.0
    oracle = 0.0
    if tasks:
        model_rates = []
        for model_id in panel_members:
            vals = [
                int(candidate.passed)
                for task in tasks
                for candidate in task.candidates
                if candidate.model_id == model_id
            ]
            model_rates.append(sum(vals) / len(vals) if vals else 0.0)
        best = max(model_rates)
        oracle = sum(
            1 for task in tasks if any(candidate.passed for candidate in task.candidates)
        ) / len(tasks)
    capture_value = None
    if oracle > best:
        capture_value = (evaluation.score - best) / (oracle - best)
    payload = {
        "panel": args.panel_id,
        "members": panel_members,
        "judge_id": args.judge_id,
        "mode": "judge_select_best_replay",
        "n": len(tasks),
        "fused_pass_rate": evaluation.score,
        "best_single": best,
        "oracle": oracle,
        "capture": capture_value,
        "spend_usd": sum(
            float(row["charged_cost_usd"])
            for row in ledger_rows
            if isinstance(row.get("charged_cost_usd"), int | float)
        ),
    }
    args.output.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    print(json.dumps(payload, sort_keys=True))
    return 0


def format_report(metrics: Mapping[str, Any]) -> str:
    lines = [
        "# Phase 0 C3 transfer pilot report",
        "",
        f"- Verdict: **{metrics['verdict']}**",
        f"- Total API spend tracked: ${metrics['total_spend_usd']:.4f}",
        "- Workload: single-shot LiveCodeBench-style algorithmic tasks; deterministic "
        "stdin/stdout grading.",
        "",
        "## Per-model pass rates",
        "",
        "| Model | n | pass@1 | Wilson 95% CI | provider failures |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    for row in metrics["per_model"]:
        lines.append(
            f"| `{row['endpoint_id']}` ({row['model']}) | {row['n']} | "
            f"{pct(row['pass_rate'])} | [{pct(row['ci_low'])}, {pct(row['ci_high'])}] | "
            f"{row['provider_failures']} |"
        )
    lines.extend(["", "## Pre-named panel oracle/headroom", ""])
    lines.append("| Panel | Members | n | best single | oracle | headroom | bootstrap 95% CI |")
    lines.append("| --- | --- | ---: | ---: | ---: | ---: | ---: |")
    for panel in metrics["panels"]:
        lines.append(
            f"| {panel['panel_id']} | {', '.join(panel['members'])} | {panel['n']} | "
            f"{pct(panel['best_single'])} | {pct(panel['oracle'])} | {pct(panel['headroom'])} | "
            f"[{pct(panel['headroom_ci_low'])}, {pct(panel['headroom_ci_high'])}] |"
        )
    sign_summary = metrics["sign_agreement"]
    lines.extend(
        [
            "",
            "## Public vs calibrated failure-dependence signs",
            "",
            f"Agreement: {sign_summary['agreed']} / {sign_summary['total']}",
            "",
            "| Pair | public phi/sign | calibrated phi/sign | agreement | mapping note |",
            "| --- | ---: | ---: | --- | --- |",
        ]
    )
    for row in sign_summary["rows"]:
        lines.append(
            f"| {row['pair']} | {fmt(row['public_phi'])} / {row['public_sign']} | "
            f"{fmt(row['calibrated_phi'])} / {row['calibrated_sign']} | "
            f"{'yes' if row['agreement'] else 'no'} | {row['mapping_note']} |"
        )
    lines.extend(["", "## Capture"])
    capture_payload = metrics.get("capture")
    if capture_payload:
        capture_value = capture_payload.get("capture")
        lines.extend(
            [
                "",
                f"- Mode: {capture_payload.get('mode')}",
                f"- Judge: `{capture_payload.get('judge_id')}`",
                f"- n: {capture_payload.get('n')}",
                f"- fused pass rate: {pct(capture_payload.get('fused_pass_rate'))}",
                f"- best single: {pct(capture_payload.get('best_single'))}",
                f"- oracle: {pct(capture_payload.get('oracle'))}",
                f"- capture: {pct(capture_value) if capture_value is not None else 'undefined'}",
            ]
        )
    else:
        lines.append("")
        lines.append(
            "- Skipped: spend threshold or replay feasibility did not allow a cheap capture run."
        )
    lines.extend(
        [
            "",
            "## Verdict rules",
            "",
            "- Headroom >= 5 pp in a pre-named K=3 panel: "
            f"{'PASS' if metrics['headroom_pass'] else 'FAIL'}",
            "- Public/calibrated dependence sign agreement: "
            f"{'PASS' if sign_summary['passes'] else 'FAIL'}",
            "",
            "## Limitations and fallbacks",
            "",
            "- Single-shot code generation only; no agentic/multi-turn workloads were run.",
            "- Algorithmic-only domain because the in-repo harness inventory showed that this "
            "is the runnable deterministic path today.",
            "- Public model mappings include version/family mismatches; each pair is labeled "
            "in the sign table.",
            "- P1 and P3 are identical because the committed default contributes Kimi + Qwen3 "
            "and DeepSeek is the pre-registered third member.",
        ]
    )
    return "\n".join(lines) + "\n"


def pct(value: object) -> str:
    if not isinstance(value, int | float):
        return "-"
    return f"{100 * float(value):.1f}%"


def fmt(value: object) -> str:
    if not isinstance(value, int | float):
        return "-"
    return f"{float(value):.3f}"


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    sub = root.add_subparsers(dest="command", required=True)
    add_common(sub.add_parser("provider-smoke"))
    build = sub.add_parser("build-bank")
    add_common(build)
    build.add_argument("--subset", type=int, default=60)
    build.add_argument("--min-date", default="2025-06-01")
    build.add_argument("--version", default="release_v6")
    build.add_argument("--max-tests", type=int, default=0)
    build.add_argument("--test-timeout-s", type=float, default=8.0)
    build.add_argument("--budget-usd", type=float, default=60.0)
    build.add_argument("--bank", type=Path, default=DEFAULT_BANK)
    build.add_argument("--outcomes", type=Path, default=DEFAULT_OUTCOMES)
    build.add_argument("--tasks", type=Path, default=DEFAULT_TASKS)
    build.add_argument("--source-bank", type=Path, default=None)
    analyze_parser = sub.add_parser("analyze")
    analyze_parser.add_argument("--outcomes", type=Path, default=DEFAULT_OUTCOMES)
    analyze_parser.add_argument("--ledger", type=Path, default=DEFAULT_LEDGER)
    analyze_parser.add_argument("--capture", type=Path, default=DEFAULT_CAPTURE)
    analyze_parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    analyze_parser.add_argument("--metrics-json", type=Path, default=PHASE0 / "c3_metrics.json")
    capture_parser = sub.add_parser("capture")
    add_common(capture_parser)
    capture_parser.add_argument("--bank", type=Path, default=DEFAULT_BANK)
    capture_parser.add_argument("--outcomes", type=Path, default=DEFAULT_OUTCOMES)
    capture_parser.add_argument("--output", type=Path, default=DEFAULT_CAPTURE)
    capture_parser.add_argument("--judge-id", default="kimi")
    capture_parser.add_argument(
        "--panel-id",
        choices=sorted(PANELS),
        default="P1_public_complementarity",
    )
    capture_parser.add_argument("--cache-dir", type=Path, default=CACHE / "c3_capture_cache")
    capture_parser.add_argument("--test-timeout-s", type=float, default=8.0)
    return root


def add_common(command: argparse.ArgumentParser) -> None:
    command.add_argument("--models", default="gpt55,sonnet,kimi,deepseek,qwen3")
    command.add_argument("--sonnet-model", default=None)
    command.add_argument("--max-tokens", type=int, default=4096)
    command.add_argument("--request-timeout-s", type=float, default=180.0)
    command.add_argument("--concurrency", type=int, default=1)
    command.add_argument("--phase", default="c3")
    command.add_argument("--ledger", type=Path, default=DEFAULT_LEDGER)


def main() -> int:
    args = parser().parse_args()
    if args.command == "provider-smoke":
        return asyncio.run(provider_smoke(args))
    if args.command == "build-bank":
        return asyncio.run(build_bank(args))
    if args.command == "capture":
        return asyncio.run(capture(args))
    if args.command == "analyze":
        return analyze(args)
    raise AssertionError(args.command)


if __name__ == "__main__":
    raise SystemExit(main())
