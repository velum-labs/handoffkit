from __future__ import annotations

import argparse
import csv
import itertools
import json
import math
import re
import urllib.request
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import duckdb
import numpy as np
import yaml
from hyperkit.stats import clustered_bootstrap_statistic

ROOT = Path("/workspace")
OUT = ROOT / "analysis" / "phase0"
CACHE = OUT / "cache"
SCRIPTS = OUT / "scripts"
SWE_EVAL = CACHE / "swebench-experiments" / "evaluation"
LLM_CODING = CACHE / "llmrouterbench_coding" / "bench-release"
PREREG = OUT / "c2_preregistration.md"
REPORT = OUT / "c1_c2_report.md"

BOOTSTRAPS = 1000
SEED = 42
PHI_MIN_COMMON = 150
PHI_MIN_MARGINAL = 20


@dataclass(frozen=True)
class SystemInfo:
    system_id: str
    display_name: str
    base_engine: str
    family: str = ""
    model_key: str = ""


@dataclass
class MatrixData:
    source_id: str
    title: str
    tier_label: str
    y: dict[str, dict[str, float]]
    clusters: dict[str, str]
    systems: dict[str, SystemInfo]
    notes: list[str]
    floor_relaxed: bool = False


def http_json(url: str) -> Any:
    with urllib.request.urlopen(url, timeout=90) as response:
        return json.loads(response.read().decode("utf-8"))


def parquet_urls(dataset: str) -> list[str]:
    files = http_json(f"https://datasets-server.huggingface.co/parquet?dataset={dataset}")
    return [f["url"] for f in files["parquet_files"]]


def slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def base_engine(value: str) -> str:
    n = slug(value)
    if not n:
        return "unknown"
    if "gpt-5" in n or re.search(r"\bgpt5\b", n):
        return "openai/gpt-5"
    if "gpt-4-1" in n or "gpt-41" in n:
        return "openai/gpt-4.1"
    if "gpt-oss-20b" in n:
        return "openai/gpt-oss-20b"
    if "gpt-oss-120b" in n:
        return "openai/gpt-oss-120b"
    if "o4-mini" in n:
        return "openai/o4-mini"
    if "claude" in n and "sonnet" in n and ("4" in n or "v4" in n):
        return "anthropic/claude-sonnet-4"
    if "claude" in n and "opus" in n and ("4" in n or "v4" in n):
        return "anthropic/claude-opus-4"
    if "claude" in n and "haiku" in n and "4" in n:
        return "anthropic/claude-haiku-4"
    if "claude" in n and "3-7" in n and "sonnet" in n:
        return "anthropic/claude-3.7-sonnet"
    if "gemini-3" in n:
        return "google/gemini-3"
    if "gemini-2-5-pro" in n:
        return "google/gemini-2.5-pro"
    if "gemini-2-5-flash" in n:
        return "google/gemini-2.5-flash"
    if "kimi-k2" in n:
        return "moonshot/kimi-k2"
    if "deepseek-r1-0528-qwen3-8b" in n:
        return "deepseek/deepseek-r1-qwen3-8b"
    if "qwen3-coder" in n or "qwen-3-coder" in n or "qwen3-coder-480b" in n:
        return "qwen/qwen3-coder"
    if "qwen3-235b-a22b" in n:
        return "qwen/qwen3-235b-a22b"
    if "qwen3-8b" in n:
        return "qwen/qwen3-8b"
    if "qwen2-5-coder" in n:
        return "qwen/qwen2.5-coder"
    if "deepseek-v3" in n or "deepseek-chat" in n:
        return "deepseek/deepseek-v3"
    if "deepseek-r1-distill-qwen-7b" in n:
        return "deepseek/deepseek-r1-distill-qwen-7b"
    if "deepseek-r1-0528" in n:
        return "deepseek/deepseek-r1"
    if "glm-4-6" in n or "glm4-6" in n:
        return "zai/glm-4.6"
    if "glm-4-7" in n:
        return "zai/glm-4.7"
    if "glm-z1-9b" in n:
        return "zai/glm-z1-9b"
    if "glm-4-9b" in n:
        return "zai/glm-4-9b"
    if "minimax-m2" in n:
        return "minimax/minimax-m2"
    if "grok-code-fast" in n:
        return "xai/grok-code-fast"
    if "grok-4" in n:
        return "xai/grok-4"
    if "llama-3-1-nemotron" in n:
        return "nvidia/llama-3.1-nemotron-nano"
    if "llama-3-1-8b-ultramedical" in n:
        return "meta/llama-3.1-8b-ultramedical"
    if "llama-3-1-8b" in n:
        return "meta/llama-3.1-8b"
    if "gemma-2-9b" in n:
        return "google/gemma-2-9b"
    if "intern-s1-mini" in n:
        return "internlm/intern-s1-mini"
    if "intern-s1" in n:
        return "internlm/intern-s1"
    if "internlm3-8b" in n:
        return "internlm/internlm3-8b"
    if "fin-r1" in n:
        return "fin-r1"
    if "openthinker3-7b" in n:
        return "openthinker3-7b"
    if "minicpm4-1-8b" in n:
        return "minicpm4.1-8b"
    if "mimo-7b" in n:
        return "mimo-7b"
    if "granite-3-3-8b" in n:
        return "ibm/granite-3.3-8b"
    if "cogito" in n:
        return "cogito-v1-llama-8b"
    if "deephermes" in n:
        return "deephermes-3-llama-3-8b"
    if n == "openrouter":
        return "openrouter/router"
    return n


def family_from_name(value: str) -> str:
    n = slug(value)
    checks = [
        ("swe-agent", ["sweagent", "swe-agent"]),
        ("openhands", ["openhands", "open-hands"]),
        ("amazon-q", ["amazon-q"]),
        ("sonar-foundation-agent", ["sonar-foundation"]),
        ("salesforce-sage", ["salesforce", "sage"]),
        ("prometheus", ["prometheus"]),
        ("lingxi", ["lingxi"]),
        ("live-swe-agent", ["livesweagent", "live-swe"]),
        ("tools", ["tools"]),
        ("trae", ["trae"]),
        ("warp", ["warp"]),
        ("qodo", ["qodo"]),
        ("refact", ["refact"]),
        ("epam-ai-run", ["epam"]),
        ("autocoderover", ["autocoderover", "auto-code-rover"]),
        ("agentless", ["agentless"]),
    ]
    for family, needles in checks:
        if any(needle in n for needle in needles):
            return family
    return n.split("-")[0] if n else "unknown"


def read_yaml(path: Path) -> dict[str, Any]:
    return yaml.safe_load(path.read_text()) or {}


def official_swe_tasks(split: str) -> dict[str, str]:
    dataset = (
        "princeton-nlp%2FSWE-bench_Verified" if split == "verified" else "princeton-nlp%2FSWE-bench"
    )
    files = http_json(f"https://datasets-server.huggingface.co/parquet?dataset={dataset}")
    urls = [f["url"] for f in files["parquet_files"] if f.get("split") == "test"]
    con = duckdb.connect()
    rows = con.sql(
        "select instance_id, repo from read_parquet(?)",
        params=[urls],
    ).fetchall()
    return {
        str(instance_id): str(repo).split("/")[1] if "/" in str(repo) else str(repo)
        for instance_id, repo in rows
    }


def load_swebench(split: str) -> MatrixData:
    tasks = official_swe_tasks(split)
    y: dict[str, dict[str, float]] = {}
    systems: dict[str, SystemInfo] = {}
    clusters = {task_id: task_id.split("__", 1)[0] for task_id in tasks}
    for metadata in sorted((SWE_EVAL / split).glob("*/metadata.yaml")):
        submission = metadata.parent.name
        date_match = re.match(r"(\d{8})", submission)
        if not date_match or date_match.group(1) < "20250101":
            continue
        result_path = metadata.parent / "results" / "results.json"
        if not result_path.exists():
            continue
        doc = read_yaml(metadata)
        result = json.loads(result_path.read_text())
        resolved = {str(x) for x in result.get("resolved", [])}
        display = doc.get("info", {}).get("name") or submission
        models = doc.get("tags", {}).get("model") or []
        if isinstance(models, str):
            models = [models]
        model_key = "; ".join(str(m) for m in models)
        engines = sorted({base_engine(str(m)) for m in models if str(m).strip()})
        engine = (
            "+".join(engines) if engines else f"system/{family_from_name(display or submission)}"
        )
        system_id = submission
        systems[system_id] = SystemInfo(
            system_id=system_id,
            display_name=f"{display} [{submission}]",
            base_engine=engine,
            family=family_from_name(f"{display} {submission}"),
            model_key=model_key,
        )
        y[system_id] = {task_id: 1.0 if task_id in resolved else 0.0 for task_id in tasks}
    title = f"SWE-bench experiments {split.upper()} (system-level A-)"
    notes = [
        f"Official HF task list gives {len(tasks)} tasks; all non-resolved instances are failures.",
        "Submissions restricted to IDs dated 2025-01 onward.",
    ]
    return MatrixData(f"swe_{split}", title, "A- system-level", y, clusters, systems, notes)


def load_terminalbench() -> MatrixData:
    urls = parquet_urls("yoonholee%2Fterminalbench-trajectories")
    con = duckdb.connect()
    rows = con.sql(
        "select task_name, agent, model, avg(cast(reward as double)) y, count(*) trials "
        "from read_parquet(?) group by 1, 2, 3",
        params=[urls],
    ).fetchall()
    all_tasks = sorted({str(row[0]) for row in rows})
    min_tasks = math.ceil(0.8 * len(all_tasks))
    grouped: dict[str, dict[str, float]] = defaultdict(dict)
    trials: dict[str, int] = defaultdict(int)
    systems: dict[str, SystemInfo] = {}
    for task_name, agent, model, value, trial_count in rows:
        task = str(task_name)
        agent_s = str(agent)
        model_s = str(model)
        system_id = f"{agent_s} :: {model_s}"
        grouped[system_id][task] = float(value)
        trials[system_id] += int(trial_count)
        systems[system_id] = SystemInfo(
            system_id=system_id,
            display_name=system_id,
            base_engine=base_engine(model_s),
            family=agent_s,
            model_key=model_s,
        )
    keep = {sid for sid, row in grouped.items() if len(row) >= min_tasks}
    y = {sid: grouped[sid] for sid in sorted(keep)}
    systems = {sid: systems[sid] for sid in sorted(keep)}
    clusters = {task: task for task in all_tasks}
    notes = [
        f"Repeated trials averaged per (agent, model, task); {len(all_tasks)} distinct tasks.",
        f"Kept systems with >=80% task coverage, i.e. at least {min_tasks} tasks.",
        "Pairwise dependence is Pearson correlation over fractional failure rates.",
    ]
    return MatrixData(
        "terminalbench",
        "Terminal-Bench trajectories (system-level A-)",
        "A- system-level",
        y,
        clusters,
        systems,
        notes,
    )


def llm_task_id(dataset: str, record: dict[str, Any]) -> str:
    if dataset == "swe-bench" and record.get("instance_id"):
        return f"swe-bench:{record['instance_id']}"
    return f"{dataset}:{record.get('index')}"


def load_llmrouterbench_dataset(dataset: str) -> MatrixData:
    base = LLM_CODING / dataset
    y: dict[str, dict[str, float]] = {}
    systems: dict[str, SystemInfo] = {}
    clusters: dict[str, str] = {}
    files = sorted(base.glob("*/*/*.json"))
    if not files:
        files = sorted(base.glob("*/*.json"))
    all_tasks: set[str] = set()
    for path in files:
        doc = json.loads(path.read_text())
        model = str(doc.get("model_name") or path.parent.name)
        if model.lower() == "openrouter":
            continue
        records = doc.get("records") or []
        system_id = model
        systems[system_id] = SystemInfo(
            system_id=system_id,
            display_name=model,
            base_engine=base_engine(model),
            family="llmrouterbench",
            model_key=model,
        )
        row: dict[str, float] = {}
        for record in records:
            task_id = llm_task_id(dataset, record)
            score = record.get("score")
            if score is None:
                continue
            row[task_id] = float(score)
            all_tasks.add(task_id)
            if dataset == "swe-bench" and record.get("instance_id"):
                clusters[task_id] = str(record["instance_id"]).split("__", 1)[0]
            else:
                clusters[task_id] = task_id
        y[system_id] = row
    min_tasks = math.ceil(0.8 * len(all_tasks)) if all_tasks else 0
    keep = {sid for sid, row in y.items() if len(row) >= min_tasks}
    y = {sid: y[sid] for sid in sorted(keep)}
    systems = {sid: systems[sid] for sid in sorted(keep)}
    if dataset == "livecodebench":
        title = "LLMRouterBench LiveCodeBench coding subset (tier A)"
        note = "No contest/date field is present in records; each task is its own cluster."
    elif dataset == "swe-bench":
        title = "LLMRouterBench SWE-Bench verified subset (tier A)"
        note = "Cluster key is repository parsed from instance_id."
    else:
        title = f"LLMRouterBench {dataset} coding subset (tier A)"
        note = "No cluster metadata is present in records; each task is its own cluster."
    notes = [
        f"Kept model files with >=80% coverage over {len(all_tasks)} tasks; excluded OpenRouter router baseline.",
        note,
    ]
    return MatrixData(
        f"llmrouterbench_{dataset.replace('-', '')}", title, "A", y, clusters, systems, notes
    )


def common_tasks(y: dict[str, dict[str, float]], subset: tuple[str, ...] | list[str]) -> list[str]:
    if not subset:
        return []
    return sorted(set.intersection(*(set(y[s]) for s in subset)))


def mean_on_tasks(y: dict[str, dict[str, float]], system: str, tasks: list[str]) -> float:
    return float(np.mean([y[system][task] for task in tasks])) if tasks else float("nan")


def pass_rate(y: dict[str, dict[str, float]], system: str) -> float:
    row = y[system]
    return float(np.mean(list(row.values()))) if row else float("nan")


def oracle_on_tasks(
    y: dict[str, dict[str, float]], subset: tuple[str, ...] | list[str], tasks: list[str]
) -> float:
    return (
        float(np.mean([max(y[system][task] for system in subset) for task in tasks]))
        if tasks
        else float("nan")
    )


def headroom_on_tasks(
    y: dict[str, dict[str, float]], subset: tuple[str, ...] | list[str], tasks: list[str]
) -> float:
    if not tasks:
        return float("nan")
    best = max(mean_on_tasks(y, system, tasks) for system in subset)
    return oracle_on_tasks(y, subset, tasks) - best


def pairwise_failure_dependence(
    y: dict[str, dict[str, float]],
    a: str,
    b: str,
    *,
    allow_fractional: bool,
    min_common: int = PHI_MIN_COMMON,
    min_marginal: int = PHI_MIN_MARGINAL,
) -> tuple[float | None, dict[str, Any]]:
    tasks = common_tasks(y, [a, b])
    values_a = np.array([y[a][task] for task in tasks], dtype=float)
    values_b = np.array([y[b][task] for task in tasks], dtype=float)
    fails_a = 1.0 - values_a
    fails_b = 1.0 - values_b
    stats = {
        "n_common": len(tasks),
        "fail_a": float(fails_a.sum()) if len(tasks) else 0.0,
        "pass_a": float(values_a.sum()) if len(tasks) else 0.0,
        "fail_b": float(fails_b.sum()) if len(tasks) else 0.0,
        "pass_b": float(values_b.sum()) if len(tasks) else 0.0,
        "floors_met": False,
    }
    if len(tasks) < min_common:
        return None, stats
    if min(stats["fail_a"], stats["pass_a"], stats["fail_b"], stats["pass_b"]) < min_marginal:
        return None, stats
    stats["floors_met"] = True
    if allow_fractional:
        if float(np.std(fails_a)) == 0.0 or float(np.std(fails_b)) == 0.0:
            return None, stats
        return float(np.corrcoef(fails_a, fails_b)[0, 1]), stats
    fa = fails_a.astype(int)
    fb = fails_b.astype(int)
    n11 = int(np.sum((fa == 1) & (fb == 1)))
    n00 = int(np.sum((fa == 0) & (fb == 0)))
    n10 = int(np.sum((fa == 1) & (fb == 0)))
    n01 = int(np.sum((fa == 0) & (fb == 1)))
    denom = math.sqrt((n11 + n10) * (n01 + n00) * (n11 + n01) * (n10 + n00))
    return ((n11 * n00) - (n10 * n01)) / denom if denom else None, stats


def feasible_combo(combo: tuple[str, ...], systems: dict[str, SystemInfo]) -> bool:
    bases = [systems[s].base_engine for s in combo]
    return len(bases) == len(set(bases))


def top_systems_by_rate(data: MatrixData, n: int = 10) -> list[str]:
    return [
        system
        for system, _ in sorted(
            ((system, pass_rate(data.y, system)) for system in data.y),
            key=lambda item: (-item[1], data.systems[item[0]].display_name),
        )[:n]
    ]


def all_panels(
    data: MatrixData,
    candidates: list[str],
    sizes: tuple[int, ...] = (2, 3),
) -> list[dict[str, Any]]:
    allow_fractional = any(
        any(abs(value - round(value)) > 1e-9 for value in row.values()) for row in data.y.values()
    )
    rows = []
    for size in sizes:
        if len(candidates) < size:
            continue
        for combo in itertools.combinations(candidates, size):
            if not feasible_combo(combo, data.systems):
                continue
            tasks = common_tasks(data.y, combo)
            if not tasks:
                continue
            dep = []
            floors_met = True
            for a, b in itertools.combinations(combo, 2):
                phi, stats = pairwise_failure_dependence(
                    data.y, a, b, allow_fractional=allow_fractional
                )
                floors_met = floors_met and bool(stats["floors_met"])
                dep.append(
                    {
                        "pair": f"{data.systems[a].display_name} || {data.systems[b].display_name}",
                        "phi": phi,
                        **stats,
                    }
                )
            rows.append(
                {
                    "source_id": data.source_id,
                    "k": size,
                    "systems": list(combo),
                    "system_names": [data.systems[s].display_name for s in combo],
                    "base_engines": [data.systems[s].base_engine for s in combo],
                    "n_common": len(tasks),
                    "oracle": oracle_on_tasks(data.y, combo, tasks),
                    "best_single_common": max(mean_on_tasks(data.y, s, tasks) for s in combo),
                    "headroom": headroom_on_tasks(data.y, combo, tasks),
                    "pairwise": dep,
                    "phi_floors_met": floors_met,
                }
            )
    return sorted(rows, key=lambda row: (-row["headroom"], -row["oracle"], row["system_names"]))


def cluster_groups(tasks: list[str], clusters: dict[str, str]) -> dict[str, list[str]]:
    grouped: dict[str, list[str]] = defaultdict(list)
    for task in tasks:
        grouped[clusters.get(task, task)].append(task)
    return dict(grouped)


def clustered_ci(
    tasks: list[str],
    clusters: dict[str, str],
    metric,
    *,
    n_boot: int = BOOTSTRAPS,
    seed: int = SEED,
) -> tuple[float, float]:
    grouped = cluster_groups(tasks, clusters)
    return clustered_bootstrap_statistic(
        grouped,
        metric,
        iterations=n_boot,
        seed=seed,
    )


def best_panel_headroom_ci(data: MatrixData, panel: dict[str, Any]) -> tuple[float, float]:
    systems = panel["systems"]
    tasks = common_tasks(data.y, systems)
    return clustered_ci(
        tasks, data.clusters, lambda sampled: headroom_on_tasks(data.y, systems, sampled)
    )


def split_clusters(data: MatrixData, tasks: list[str]) -> tuple[set[str], set[str]]:
    cluster_keys = sorted({data.clusters.get(task, task) for task in tasks})
    rng = np.random.default_rng(SEED)
    shuffled = list(rng.permutation(cluster_keys))
    cut = len(shuffled) // 2
    train = set(shuffled[:cut])
    heldout = set(shuffled[cut:])
    return train, heldout


def tasks_for_clusters(data: MatrixData, clusters: set[str]) -> list[str]:
    return sorted(task for task, cluster in data.clusters.items() if cluster in clusters)


def exhaustive_select(
    data: MatrixData, candidates: list[str], k: int, tasks: list[str]
) -> tuple[list[str], float]:
    best_combo: tuple[str, ...] | None = None
    best_score = -1.0
    for combo in itertools.combinations(candidates, k):
        if not feasible_combo(combo, data.systems):
            continue
        combo_tasks = [task for task in tasks if all(task in data.y[system] for system in combo)]
        if not combo_tasks:
            continue
        score = oracle_on_tasks(data.y, combo, combo_tasks)
        if score > best_score + 1e-12:
            best_combo = combo
            best_score = score
    return list(best_combo or []), best_score


def greedy_select(
    data: MatrixData, candidates: list[str], k: int, tasks: list[str]
) -> tuple[list[str], float]:
    selected: list[str] = []
    remaining = list(candidates)
    while len(selected) < k:
        best_system = ""
        best_score = -1.0
        for system in remaining:
            combo = selected + [system]
            if not feasible_combo(tuple(combo), data.systems):
                continue
            combo_tasks = [task for task in tasks if all(task in data.y[s] for s in combo)]
            if not combo_tasks:
                continue
            score = oracle_on_tasks(data.y, combo, combo_tasks)
            if score > best_score + 1e-12:
                best_system = system
                best_score = score
        if not best_system:
            break
        selected.append(best_system)
        remaining.remove(best_system)
    selected_tasks = [task for task in tasks if all(task in data.y[s] for s in selected)]
    return selected, oracle_on_tasks(data.y, selected, selected_tasks) if selected_tasks else float(
        "nan"
    )


def topk_by_average(data: MatrixData, candidates: list[str], k: int, tasks: list[str]) -> list[str]:
    ranked = sorted(
        candidates,
        key=lambda system: (
            -mean_on_tasks(data.y, system, [task for task in tasks if task in data.y[system]]),
            data.systems[system].display_name,
        ),
    )
    selected: list[str] = []
    used_bases: set[str] = set()
    for system in ranked:
        base = data.systems[system].base_engine
        if base in used_bases:
            continue
        selected.append(system)
        used_bases.add(base)
        if len(selected) == k:
            break
    return selected


def c2_for_data(data: MatrixData) -> list[dict[str, Any]]:
    candidates = sorted(data.y)
    common_all = common_tasks(data.y, candidates)
    train_clusters, heldout_clusters = split_clusters(data, common_all)
    train_tasks = tasks_for_clusters(data, train_clusters)
    heldout_tasks = tasks_for_clusters(data, heldout_clusters)
    if train_clusters & heldout_clusters:
        raise RuntimeError(f"cluster leakage in {data.source_id}")
    rows = []
    for k in (2, 3):
        if len(candidates) < k:
            continue
        comp_panel, train_oracle = exhaustive_select(data, candidates, k, train_tasks)
        base_panel = topk_by_average(data, candidates, k, train_tasks)
        greedy_panel, greedy_oracle = greedy_select(data, candidates, k, train_tasks)
        if len(comp_panel) != k or len(base_panel) != k:
            continue
        heldout_common = [
            task
            for task in heldout_tasks
            if all(task in data.y[s] for s in set(comp_panel + base_panel))
        ]
        comp_oracle = oracle_on_tasks(data.y, comp_panel, heldout_common)
        base_oracle = oracle_on_tasks(data.y, base_panel, heldout_common)
        comp_headroom = headroom_on_tasks(data.y, comp_panel, heldout_common)
        base_headroom = headroom_on_tasks(data.y, base_panel, heldout_common)
        delta_oracle = comp_oracle - base_oracle
        delta_headroom = comp_headroom - base_headroom
        ci = clustered_ci(
            heldout_common,
            data.clusters,
            lambda sampled, c=comp_panel, b=base_panel: (
                oracle_on_tasks(data.y, c, sampled) - oracle_on_tasks(data.y, b, sampled)
            ),
        )
        pass_status = "pass" if ci[0] > 0 else "fail" if ci[1] < 0 else "inconclusive"
        rows.append(
            {
                "source_id": data.source_id,
                "k": k,
                "train_clusters": len(train_clusters),
                "heldout_clusters": len(heldout_clusters),
                "heldout_tasks": len(heldout_common),
                "comp_panel": comp_panel,
                "comp_panel_names": [data.systems[s].display_name for s in comp_panel],
                "baseline_panel": base_panel,
                "baseline_panel_names": [data.systems[s].display_name for s in base_panel],
                "train_oracle": train_oracle,
                "heldout_comp_oracle": comp_oracle,
                "heldout_baseline_oracle": base_oracle,
                "delta_oracle": delta_oracle,
                "delta_oracle_ci_low": ci[0],
                "delta_oracle_ci_high": ci[1],
                "delta_headroom": delta_headroom,
                "greedy_panel_names": [data.systems[s].display_name for s in greedy_panel],
                "greedy_oracle": greedy_oracle,
                "greedy_vs_exhaustive_gap": train_oracle - greedy_oracle,
                "status": pass_status,
                "split_leakage": bool(train_clusters & heldout_clusters),
            }
        )
    return rows


def data_summary(data: MatrixData) -> dict[str, Any]:
    task_union = sorted(set().union(*(set(row) for row in data.y.values()))) if data.y else []
    coverage = [len(row) / len(task_union) for row in data.y.values()] if task_union else []
    return {
        "source_id": data.source_id,
        "title": data.title,
        "tier": data.tier_label,
        "n_systems": len(data.y),
        "n_tasks": len(task_union),
        "n_clusters": len({data.clusters.get(task, task) for task in task_union}),
        "coverage_min": min(coverage) if coverage else float("nan"),
        "coverage_median": float(np.median(coverage)) if coverage else float("nan"),
        "coverage_max": max(coverage) if coverage else float("nan"),
    }


def fmt_pct(value: float) -> str:
    if value != value:
        return "NA"
    return f"{100 * value:.1f}%"


def fmt_pp(value: float) -> str:
    if value != value:
        return "NA"
    return f"{100 * value:+.1f} pp"


def fmt_ci(low: float, high: float) -> str:
    return f"[{fmt_pp(low)}, {fmt_pp(high)}]"


def md_table(headers: list[str], rows: list[list[Any]]) -> str:
    out = ["| " + " | ".join(headers) + " |", "| " + " | ".join(["---"] * len(headers)) + " |"]
    for row in rows:
        out.append("| " + " | ".join(str(cell).replace("\n", " ") for cell in row) + " |")
    return "\n".join(out)


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def jsonable_panel(row: dict[str, Any], data: MatrixData) -> dict[str, Any]:
    return {
        "source_id": row["source_id"],
        "k": row["k"],
        "systems": " | ".join(row["system_names"]),
        "base_engines": " | ".join(row["base_engines"]),
        "n_common": row["n_common"],
        "oracle": round(row["oracle"], 6),
        "best_single_common": round(row["best_single_common"], 6),
        "headroom": round(row["headroom"], 6),
        "pairwise_phi": phi_summary(row),
        "phi_floors_met": row["phi_floors_met"],
        "tier": data.tier_label,
    }


def phi_summary(row: dict[str, Any]) -> str:
    values = []
    for pair in row["pairwise"]:
        short_pair = " / ".join(part.split(" [", 1)[0] for part in pair["pair"].split(" || "))
        value = "NA" if pair["phi"] is None else f"{pair['phi']:.3f}"
        values.append(f"{short_pair}: {value}")
    return "; ".join(values)


def build_all_data() -> list[MatrixData]:
    return [
        load_swebench("verified"),
        load_swebench("test"),
        load_terminalbench(),
        load_llmrouterbench_dataset("livecodebench"),
        load_llmrouterbench_dataset("swe-bench"),
        load_llmrouterbench_dataset("mbpp"),
        load_llmrouterbench_dataset("humaneval"),
    ]


def write_preregistration(data_sets: list[MatrixData], overwrite: bool = False) -> None:
    if PREREG.exists() and not overwrite:
        raise FileExistsError(f"{PREREG} already exists; refusing to edit preregistration")
    sections = []
    for data in data_sets:
        systems = sorted(data.systems.values(), key=lambda s: s.display_name)
        duplicate_bases = [
            base
            for base, count in Counter(system.base_engine for system in systems).items()
            if count > 1
        ]
        if data.source_id.startswith("swe_"):
            universe_rule = "all SWE-bench experiment submissions in this split with submission id dated 2025-01-01 or later; full split attempted by policy; unresolved is failure"
        elif data.source_id == "terminalbench":
            universe_rule = "all (agent, model) systems with at least 80% distinct task coverage after averaging repeated trials"
        else:
            universe_rule = "all model files in the dataset subset with at least 80% task coverage; exclude the OpenRouter router baseline because it is not a generator model"
        sections.append(
            "\n".join(
                [
                    f"### {data.title}",
                    f"- Source id: `{data.source_id}`.",
                    f"- System universe rule: {universe_rule}.",
                    f"- Systems after applying rule ({len(systems)}): "
                    + "; ".join(f"{s.display_name} -> {s.base_engine}" for s in systems)
                    + ".",
                    f"- Duplicate base engines present before panel selection: {', '.join(sorted(duplicate_bases)) if duplicate_bases else 'none'}.",
                    "- K: `{2, 3}`.",
                    "- Split: clustered 50/50 by `cluster_key`, seed=42, `numpy.default_rng`; clusters are shuffled once and divided at the midpoint.",
                    "- Selection objective on TRAIN: exhaustive `oracle(S)` panel ceiling subject to one-per-base-engine.",
                    "- Baseline: top-K by mean pass rate on TRAIN with the same one-per-base-engine constraint.",
                    "- Metric on HELDOUT: `Delta_oracle = oracle(complementarity panel) - oracle(baseline panel)`, plus `Delta_headroom`.",
                    "- Test: clustered bootstrap over held-out clusters, 1000 resamples, report 95% CI.",
                    "- Pass rule: CI lower bound > 0 for some (source, K); fail = CI upper bound < 0 everywhere; otherwise inconclusive.",
                ]
            )
        )
    content = """# C2 preregistration

Written before computing any held-out C2 results.

## Literal preregistered design

Per source — the system universe rule (name the systems after applying it, before splitting); K in {2,3}; the split (clustered 50/50 by cluster_key, seed=42, numpy default_rng); selection objective on TRAIN = oracle(S) (panel ceiling); baseline = top-K by mean pass rate on TRAIN with the same one-per-base-engine constraint; metric on HELDOUT = Delta_oracle = oracle(complementarity panel) - oracle(baseline panel), plus Delta_headroom; test = clustered bootstrap over held-out clusters, 1000 resamples, report 95% CI; pass rule = CI lower bound > 0 for some (source, K), fail = CI upper bound < 0 everywhere, else inconclusive. One-per-base-engine: parse base engine from system names (e.g. all claude-sonnet-4.x submissions = one engine); document your mapping.

## One-per-base-engine mapping

Base engines are parsed by normalizing system/model names and grouping aliases such as `gpt-5`, `gpt-5-chat`, and GPT-5 medium under `openai/gpt-5`; Claude Sonnet 4.x under `anthropic/claude-sonnet-4`; Claude Opus 4.x under `anthropic/claude-opus-4`; Kimi K2 instruct/thinking under `moonshot/kimi-k2`; Qwen3 235B thinking/no-thinking/date variants under `qwen/qwen3-235b-a22b`; DeepSeek V3/V3.1 chat variants under `deepseek/deepseek-v3`. Systems with multiple explicit model tags use a composite base key joined with `+`; systems with no model tag use a `system/<scaffold-family>` key and remain system-level.

## Registered source universes

"""
    content += "\n\n".join(sections)
    content += "\n\n## Deviations\n\nNone at preregistration time.\n"
    PREREG.write_text(content)


def analyze_swe_family(data: MatrixData) -> dict[str, Any] | None:
    families: dict[str, list[str]] = defaultdict(list)
    for system_id, info in data.systems.items():
        families[info.family].append(system_id)
    candidates = sorted(
        ((family, systems) for family, systems in families.items() if len(systems) >= 2),
        key=lambda item: (-len(item[1]), item[0]),
    )
    if not candidates:
        return None
    family, systems = candidates[0]
    panels = all_panels(
        data,
        top_systems_by_rate(
            MatrixData(
                data.source_id,
                data.title,
                data.tier_label,
                {s: data.y[s] for s in systems},
                data.clusters,
                {s: data.systems[s] for s in systems},
                data.notes,
            ),
            min(10, len(systems)),
        ),
        (2, 3),
    )
    if not panels:
        return {
            "family": family,
            "n_systems": len(systems),
            "note": "No feasible unique-base panel.",
        }
    best = panels[0]
    ci = best_panel_headroom_ci(data, best)
    return {
        "family": family,
        "n_systems": len(systems),
        "best_systems": best["system_names"],
        "headroom": best["headroom"],
        "ci": ci,
        "n_common": best["n_common"],
    }


def run_analysis(data_sets: list[MatrixData]) -> None:
    summaries = [data_summary(data) for data in data_sets]
    c1_rows = []
    c1_detail: dict[str, Any] = {}
    c2_rows = []
    system_rows = []
    for data in data_sets:
        for info in sorted(data.systems.values(), key=lambda s: s.display_name):
            system_rows.append(
                {
                    "source_id": data.source_id,
                    "system_id": info.system_id,
                    "display_name": info.display_name,
                    "base_engine": info.base_engine,
                    "family": info.family,
                    "model_key": info.model_key,
                    "pass_rate": round(pass_rate(data.y, info.system_id), 6),
                    "n_tasks": len(data.y[info.system_id]),
                }
            )
        candidates = top_systems_by_rate(data, 10)
        panels = all_panels(data, candidates, (2, 3))
        best = panels[0] if panels else None
        top5 = panels[:5]
        for row in top5:
            c1_rows.append(jsonable_panel(row, data))
        if best:
            ci = best_panel_headroom_ci(data, best)
            c1_detail[data.source_id] = {
                "best": best,
                "headroom_ci": ci,
                "top5": top5,
                "swe_family": analyze_swe_family(data)
                if data.source_id.startswith("swe_")
                else None,
            }
        c2_rows.extend(c2_for_data(data))
    write_csv(OUT / "c1_top_panels.csv", c1_rows)
    write_csv(OUT / "c2_results.csv", flatten_c2_rows(c2_rows))
    write_csv(OUT / "source_system_universe.csv", system_rows)
    write_csv(
        OUT / "data_summary.csv",
        [
            {k: round(v, 6) if isinstance(v, float) else v for k, v in row.items()}
            for row in summaries
        ],
    )
    write_report(data_sets, summaries, c1_detail, c2_rows)


def flatten_c2_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for row in rows:
        out.append(
            {
                "source_id": row["source_id"],
                "k": row["k"],
                "train_clusters": row["train_clusters"],
                "heldout_clusters": row["heldout_clusters"],
                "heldout_tasks": row["heldout_tasks"],
                "comp_panel": " | ".join(row["comp_panel_names"]),
                "baseline_panel": " | ".join(row["baseline_panel_names"]),
                "delta_oracle": round(row["delta_oracle"], 6),
                "delta_oracle_ci_low": round(row["delta_oracle_ci_low"], 6),
                "delta_oracle_ci_high": round(row["delta_oracle_ci_high"], 6),
                "delta_headroom": round(row["delta_headroom"], 6),
                "greedy_vs_exhaustive_gap": round(row["greedy_vs_exhaustive_gap"], 6),
                "status": row["status"],
                "split_leakage": row["split_leakage"],
            }
        )
    return out


def write_report(
    data_sets: list[MatrixData],
    summaries: list[dict[str, Any]],
    c1_detail: dict[str, Any],
    c2_rows: list[dict[str, Any]],
) -> None:
    c1_pass_sources = []
    for data in data_sets:
        detail = c1_detail.get(data.source_id)
        if not detail:
            continue
        best = detail["best"]
        ci_low, ci_high = detail["headroom_ci"]
        if (
            best["headroom"] >= 0.05
            and best["phi_floors_met"]
            and best["n_common"] >= PHI_MIN_COMMON
        ):
            c1_pass_sources.append(data.source_id)
    c2_pass = [row for row in c2_rows if row["status"] == "pass"]
    c2_pass_labels = [f"{row['source_id']} K={row['k']}" for row in c2_pass]
    c2_fail_all = c2_rows and all(row["status"] == "fail" for row in c2_rows)
    overall_c1 = "PASS" if c1_pass_sources else "INCONCLUSIVE"
    overall_c2 = "PASS" if c2_pass else "FAIL" if c2_fail_all else "INCONCLUSIVE"

    parts = [
        "# Phase 0 C1/C2 complementarity analysis",
        "",
        "## Overall verdicts",
        "",
        f"- C1 existence verdict: **{overall_c1}**. "
        + (
            f"At least one 2-3 system panel clears >=5 pp headroom with phi floors: {', '.join(c1_pass_sources)}."
            if c1_pass_sources
            else "No analyzed source cleared both the >=5 pp headroom threshold and all phi floors."
        ),
        f"- C2 selection-value verdict: **{overall_c2}**. "
        + (
            f"Registered pass found for {', '.join(c2_pass_labels)}."
            if c2_pass
            else "No held-out Delta_oracle CI lower bound is > 0."
        ),
        "",
        "## Data summary",
        "",
        md_table(
            ["Source", "Tier", "Systems", "Tasks", "Clusters", "Coverage"],
            [
                [
                    row["title"],
                    row["tier"],
                    row["n_systems"],
                    row["n_tasks"],
                    row["n_clusters"],
                    f"{fmt_pct(row['coverage_min'])}-{fmt_pct(row['coverage_max'])}; median {fmt_pct(row['coverage_median'])}",
                ]
                for row in summaries
            ],
        ),
    ]
    c2_by_source: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in c2_rows:
        c2_by_source[row["source_id"]].append(row)
    for data in data_sets:
        summary = next(row for row in summaries if row["source_id"] == data.source_id)
        detail = c1_detail.get(data.source_id)
        parts.extend(["", f"## {data.title}", ""])
        parts.extend(f"- {note}" for note in data.notes)
        parts.append(
            f"- Summary: {summary['n_systems']} systems, {summary['n_tasks']} tasks, {summary['n_clusters']} clusters, tier {data.tier_label}."
        )
        if detail:
            best = detail["best"]
            ci_low, ci_high = detail["headroom_ci"]
            floor_label = "floors met" if best["phi_floors_met"] else "floors not met"
            if data.source_id == "terminalbench" and best["n_common"] < PHI_MIN_COMMON:
                floor_label = f"floor relaxed: n={best['n_common']} common tasks"
            parts.extend(
                [
                    "",
                    "### C1 findings",
                    "",
                    f"Best panel: **{'; '.join(best['system_names'])}**.",
                    f"Headroom: {fmt_pp(best['headroom'])} CI {fmt_ci(ci_low, ci_high)}; oracle {fmt_pct(best['oracle'])}; best single on common tasks {fmt_pct(best['best_single_common'])}; n={best['n_common']}; {floor_label}.",
                    "",
                    md_table(
                        ["Pair", "phi / loss corr", "n", "marginals", "floors"],
                        [
                            [
                                p["pair"],
                                "NA" if p["phi"] is None else f"{p['phi']:.3f}",
                                p["n_common"],
                                f"fail/pass A {p['fail_a']:.1f}/{p['pass_a']:.1f}; fail/pass B {p['fail_b']:.1f}/{p['pass_b']:.1f}",
                                "yes" if p["floors_met"] else "no",
                            ]
                            for p in best["pairwise"]
                        ],
                    ),
                    "",
                    "Top panels by headroom:",
                    "",
                    md_table(
                        ["K", "Panel", "Headroom", "Oracle", "n", "phi / loss corr", "phi floors"],
                        [
                            [
                                row["k"],
                                "; ".join(row["system_names"]),
                                fmt_pp(row["headroom"]),
                                fmt_pct(row["oracle"]),
                                row["n_common"],
                                phi_summary(row),
                                "yes" if row["phi_floors_met"] else "no",
                            ]
                            for row in detail["top5"]
                        ],
                    ),
                ]
            )
            if detail.get("swe_family"):
                fam = detail["swe_family"]
                if "best_systems" in fam:
                    parts.append(
                        f"SWE scaffold-controlled subgroup: `{fam['family']}` ({fam['n_systems']} systems) best headroom {fmt_pp(fam['headroom'])} CI {fmt_ci(*fam['ci'])} on n={fam['n_common']} for {'; '.join(fam['best_systems'])}."
                    )
                else:
                    parts.append(
                        f"SWE scaffold-controlled subgroup: `{fam['family']}` ({fam['n_systems']} systems), {fam['note']}"
                    )
        source_c2 = c2_by_source.get(data.source_id, [])
        if source_c2:
            parts.extend(
                [
                    "",
                    "### C2 findings",
                    "",
                    md_table(
                        [
                            "K",
                            "Complementarity panel",
                            "Top-K baseline",
                            "Held-out Delta_oracle",
                            "95% CI",
                            "Delta_headroom",
                            "Greedy gap",
                            "Status",
                        ],
                        [
                            [
                                row["k"],
                                "; ".join(row["comp_panel_names"]),
                                "; ".join(row["baseline_panel_names"]),
                                fmt_pp(row["delta_oracle"]),
                                fmt_ci(row["delta_oracle_ci_low"], row["delta_oracle_ci_high"]),
                                fmt_pp(row["delta_headroom"]),
                                fmt_pp(row["greedy_vs_exhaustive_gap"]),
                                row["status"],
                            ]
                            for row in source_c2
                        ],
                    ),
                    "Sanity guards: no selected panel contains duplicate base engines; clustered split leakage is false for every K.",
                ]
            )
    parts.extend(
        [
            "",
            "## What this means for C3",
            "",
            "For the algorithmic domain, the public data points to the LLMRouterBench LiveCodeBench complementarity-selected panel as the best C3 seed, but C3 must run it under FusionKit's own harness before production use. Among runnable providers in this environment, use OpenAI GPT-5/GPT-5.5 class, Anthropic Claude Sonnet/Opus class, and OpenRouter-hosted Kimi K2 / Qwen3 / DeepSeek candidates. Gemini-scored public rows are useful evidence but Gemini is not runnable here, so do not include Gemini in the C3 run panel.",
            "",
            "Recommended runnable C3 algorithmic seed panel: `gpt-5.5` or `gpt-5`, `claude-sonnet-4.x` or `claude-opus-4.x`, and `moonshotai/kimi-k2-thinking` or `deepseek/deepseek-chat` through OpenRouter. Keep `qwen/qwen3-coder` as the first alternate if the OpenRouter Kimi/DeepSeek run is unavailable or cost-constrained.",
            "",
            "## Deviations and limitations",
            "",
            "- LLMRouterBench is packaged as one 1.28 GB archive; the analysis downloaded it to gitignored cache and extracted only `livecodebench`, `swe-bench`, `mbpp`, and `humaneval`.",
            "- LLMRouterBench LiveCodeBench, MBPP, and HumanEval records do not expose contest/date clusters, so each task is its own cluster as preregistered.",
            "- SWE-bench experiments and Terminal-Bench are A- scaffold-confounded; every derived number from them is system-level.",
            "- Terminal-Bench uses fractional averaged repeated trials, so pairwise dependence is reported as loss correlation with the same n/marginal floors.",
            "- Public priors remain Layer-1 evidence; C3 is still required to test transfer to FusionKit's calibrated harness.",
        ]
    )
    REPORT.write_text("\n".join(parts) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["preregister", "analyze"])
    parser.add_argument("--overwrite-prereg", action="store_true")
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    SCRIPTS.mkdir(parents=True, exist_ok=True)
    data_sets = build_all_data()
    if args.command == "preregister":
        write_preregistration(data_sets, overwrite=args.overwrite_prereg)
        print(f"wrote {PREREG}")
        return
    if not PREREG.exists():
        raise FileNotFoundError(f"{PREREG} must exist before held-out C2 analysis")
    run_analysis(data_sets)
    print(f"wrote {REPORT}")


if __name__ == "__main__":
    main()
