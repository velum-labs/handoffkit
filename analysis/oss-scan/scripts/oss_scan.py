from __future__ import annotations

import csv
import itertools
import json
import math
import re
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import yaml
from datasets import DatasetDict, load_dataset

ROOT = Path("/workspace")
OUT = ROOT / "analysis" / "oss-scan"
CACHE = ROOT / "analysis" / "phase0" / "cache"
SWE_EVAL = CACHE / "swebench-experiments" / "evaluation"
LLM_CODING = CACHE / "llmrouterbench_coding" / "bench-release"
BOOTSTRAPS = 1000
SEED = 42
PHI_MIN_COMMON = 150
PHI_MIN_MARGINAL = 20
LOW_PHI_ALLOW = 0.30


@dataclass(frozen=True)
class Classification:
    label: str
    is_oss: bool
    reasoning: str
    base_model: str
    teacher: str
    lineage: str
    base_key: str
    teacher_key: str


@dataclass(frozen=True)
class Domain:
    key: str
    title: str
    data: MatrixData
    interpretation: str


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


def fmt_pct(value: float) -> str:
    return "NA" if value != value else f"{100 * value:.1f}%"


def fmt_pp(value: float) -> str:
    return "NA" if value != value else f"{100 * value:+.1f} pp"


def fmt_ci(low: float, high: float) -> str:
    return f"[{fmt_pp(low)}, {fmt_pp(high)}]"


def md_table(headers: list[str], rows: list[list[Any]]) -> str:
    out = ["| " + " | ".join(headers) + " |", "| " + " | ".join(["---"] * len(headers)) + " |"]
    for row in rows:
        out.append(
            "| "
            + " | ".join(str(cell).replace("\n", " ").replace("|", r"\|") for cell in row)
            + " |"
        )
    return "\n".join(out)


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        path.write_text("")
        return
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def lineage_for_token(token: str) -> tuple[str, str, str, str]:
    n = slug(token)
    base = "unknown"
    teacher = ""
    note = "lineage uncertain"
    if "deepseek-r1-0528-qwen3-8b" in n:
        base, teacher, note = "Qwen3-8B", "DeepSeek-R1-0528", "DeepSeek R1 distill on Qwen3-8B"
    elif "deepseek-r1-distill-qwen-7b" in n:
        base, teacher, note = (
            "Qwen/Qwen2.5 family 7B",
            "DeepSeek-R1",
            "DeepSeek R1 distill on Qwen 7B",
        )
    elif "fin-r1" in n:
        base, teacher, note = (
            "unknown",
            "DeepSeek-R1 (uncertain)",
            "R1-style open fine-tune; base uncertain",
        )
    elif "openthinker" in n:
        base, teacher, note = (
            "Qwen-family 7B (uncertain)",
            "DeepSeek-R1 (uncertain)",
            "open reasoning distill; exact base uncertain",
        )
    elif "qwen3-coder" in n or "qwencoder" in n:
        base, teacher, note = "Qwen3-Coder", "", "Qwen3-Coder open-weights family"
    elif "qwen3-235b" in n:
        base, teacher, note = "Qwen3-235B-A22B", "", "Qwen3 MoE open-weights family"
    elif "qwen3-8b" in n:
        base, teacher, note = "Qwen3-8B", "", "Qwen3 open-weights family"
    elif "qwen2-5-coder" in n or "qwen2-5-72b" in n or "qwen2-5-7b" in n:
        base, teacher, note = "Qwen2.5-Coder", "", "Qwen2.5-Coder open-weights family"
    elif "kimi-k2" in n:
        base, teacher, note = "Kimi K2", "", "Moonshot Kimi K2 open-weights MoE"
    elif "deepseek-v3" in n or "deepseek-chat" in n:
        base, teacher, note = "DeepSeek-V3", "", "DeepSeek-V3 open-weights family"
    elif "deepseek-r1" in n:
        base, teacher, note = "DeepSeek-R1", "", "DeepSeek-R1 open-weights reasoning family"
    elif "glm-z1-9b" in n:
        base, teacher, note = (
            "GLM-4-9B",
            "GLM-Z1/RL (uncertain)",
            "Z.ai GLM-Z1 open reasoning family",
        )
    elif "glm-4-6" in n or "glm4-6" in n:
        base, teacher, note = "GLM-4.6", "", "Z.ai GLM open-weights family"
    elif "glm-4-9b" in n:
        base, teacher, note = "GLM-4-9B", "", "Z.ai GLM open-weights family"
    elif "intern-s1-mini" in n:
        base, teacher, note = "Intern-S1-mini", "", "InternLM open-weights family"
    elif "intern-s1" in n:
        base, teacher, note = "Intern-S1", "", "InternLM open-weights family"
    elif "internlm3-8b" in n:
        base, teacher, note = "InternLM3-8B", "", "InternLM open-weights family"
    elif "llama-3-1-nemotron" in n or "nemotron-nano" in n:
        base, teacher, note = (
            "Llama-3.1",
            "NVIDIA Nemotron alignment (uncertain)",
            "NVIDIA Nemotron derivative of Llama",
        )
    elif "llama-3-1-8b-ultramedical" in n:
        base, teacher, note = (
            "Llama-3.1-8B",
            "UltraMedical fine-tune (uncertain)",
            "Llama derivative",
        )
    elif "llama-3-1-8b" in n:
        base, teacher, note = "Llama-3.1-8B", "", "Meta Llama open-weights family"
    elif "deephermes" in n:
        base, teacher, note = (
            "Llama-3-8B",
            "Nous/Hermes synthetic data (uncertain)",
            "Llama derivative",
        )
    elif "cogito" in n:
        base, teacher, note = "Llama-3.x-8B", "Cogito alignment (uncertain)", "Llama derivative"
    elif "gemma-2-9b" in n:
        base, teacher, note = "Gemma-2-9B", "", "Google Gemma open-weights family"
    elif "granite-3-3-8b" in n:
        base, teacher, note = "Granite-3.3-8B", "", "IBM Granite open-weights family"
    elif "mimo-7b" in n:
        base, teacher, note = "MiMo-7B", "RL fine-tune (uncertain)", "open small reasoning model"
    elif "minicpm4-1-8b" in n:
        base, teacher, note = "MiniCPM4.1-8B", "", "MiniCPM open-weights family"
    elif "minimax-m2" in n:
        base, teacher, note = "MiniMax M2", "", "MiniMax M2 open-weights family"
    elif "devstral" in n:
        base, teacher, note = "Devstral/Mistral", "", "Mistral/Devstral open-weights family"
    elif "mistral" in n:
        base, teacher, note = "Mistral", "", "Mistral open-weights family"
    elif "gpt-oss-120b" in n:
        base, teacher, note = (
            "gpt-oss-120b",
            "OpenAI distillation/alignment (uncertain)",
            "OpenAI gpt-oss open-weights family",
        )
    elif "gpt-oss-20b" in n:
        base, teacher, note = (
            "gpt-oss-20b",
            "OpenAI distillation/alignment (uncertain)",
            "OpenAI gpt-oss open-weights family",
        )
    elif "skywork-swe" in n:
        base, teacher, note = "Skywork-SWE", "", "Skywork SWE open-weights family"
    elif "mcts-refine-7b" in n:
        base, teacher, note = (
            "MCTS-Refine-7B",
            "uncertain",
            "open SWE fine-tune; exact ancestry uncertain",
        )
    return base, teacher, note, f"base={base}; teacher={teacher or 'none'}; {note}"


def is_closed_token(token: str) -> bool:
    n = slug(token)
    if "gpt-oss" in n:
        return False
    closed_patterns = [
        "claude",
        "gemini",
        "gpt-",
        "gpt4",
        "gpt5",
        "openai",
        "o1",
        "o3",
        "o4-mini",
        "grok",
        "xai",
        "nova",
        "doubao",
        "amazon-q",
        "jules",
    ]
    return any(pattern in n for pattern in closed_patterns) and "gemma" not in n


def is_known_oss_token(token: str) -> bool:
    n = slug(token)
    open_patterns = [
        "qwen",
        "deepseek",
        "kimi-k2",
        "glm",
        "zai",
        "llama",
        "mistral",
        "devstral",
        "minimax-m2",
        "mimo-7b",
        "gpt-oss",
        "internlm",
        "intern-s1",
        "nemotron",
        "gemma",
        "granite",
        "fin-r1",
        "openthinker",
        "minicpm",
        "deephermes",
        "cogito",
        "skywork-swe",
        "mcts-refine",
    ]
    return any(pattern in n for pattern in open_patterns)


def combine_lineage(parts: list[Classification]) -> tuple[str, str, str, str, str]:
    base_values = sorted(
        {part.base_model for part in parts if part.base_model and part.base_model != "unknown"}
    )
    teacher_values = sorted({part.teacher for part in parts if part.teacher})
    base = "+".join(base_values) if base_values else "unknown"
    teacher = "+".join(teacher_values)
    lineage = " | ".join(part.lineage for part in parts)
    base_key = "+".join(
        sorted({part.base_key for part in parts if part.base_key and part.base_key != "unknown"})
    )
    teacher_key = "+".join(sorted({part.teacher_key for part in parts if part.teacher_key}))
    return base, teacher, lineage, base_key or "unknown", teacher_key


def classify_token(token: str, *, swe_os_model: bool | None = None) -> Classification:
    base, teacher, note, lineage = lineage_for_token(token)
    base_key = slug(base) if base else "unknown"
    teacher_key = slug(teacher) if teacher else ""
    if is_known_oss_token(token):
        return Classification(
            "oss",
            True,
            f"known open-weights family ({note})",
            base,
            teacher,
            lineage,
            base_key,
            teacher_key,
        )
    if swe_os_model is True and not is_closed_token(token):
        return Classification(
            "oss",
            True,
            "SWE-bench metadata marks os_model=true; exact lineage uncertain",
            base,
            teacher,
            lineage,
            base_key,
            teacher_key,
        )
    if is_closed_token(token):
        return Classification(
            "closed",
            False,
            "closed/API-only family under the OSS-first definition",
            base,
            teacher,
            lineage,
            base_key,
            teacher_key,
        )
    return Classification(
        "unknown",
        False,
        "not confirmed open-weights; excluded from OSS universe",
        base,
        teacher,
        lineage,
        base_key,
        teacher_key,
    )


def swe_metadata(source_id: str, system_id: str) -> dict[str, Any]:
    if not source_id.startswith("swe_"):
        return {}
    split = "verified" if source_id == "swe_verified" else "test"
    path = SWE_EVAL / split / system_id / "metadata.yaml"
    if not path.exists():
        return {}
    return yaml.safe_load(path.read_text()) or {}


def classify_system(domain_key: str, source_id: str, info: Any) -> Classification:
    metadata = swe_metadata(source_id, info.system_id)
    tags = metadata.get("tags", {}) if metadata else {}
    swe_os_model = tags.get("os_model") if isinstance(tags, dict) else None
    tokens: list[str]
    if source_id.startswith("swe_"):
        raw_models = tags.get("model") if isinstance(tags, dict) else None
        if isinstance(raw_models, str):
            tokens = [raw_models]
        elif isinstance(raw_models, list):
            tokens = [str(model) for model in raw_models if str(model).strip()]
        else:
            tokens = []
    elif info.model_key:
        tokens = [part.strip() for part in str(info.model_key).split(";") if part.strip()]
    else:
        tokens = [info.display_name]
    if not tokens:
        return Classification(
            "unknown",
            False,
            "no explicit model tag; system excluded from OSS universe",
            "unknown",
            "",
            "base=unknown; teacher=none; missing explicit model tag",
            "unknown",
            "",
        )
    parts = [
        classify_token(token, swe_os_model=bool(swe_os_model) if swe_os_model is not None else None)
        for token in tokens
    ]
    base, teacher, lineage, base_key, teacher_key = combine_lineage(parts)
    if all(part.is_oss for part in parts):
        return Classification(
            "oss",
            True,
            "all tagged models are OSS/open-weights",
            base,
            teacher,
            lineage,
            base_key,
            teacher_key,
        )
    if any(part.label == "closed" for part in parts):
        return Classification(
            "closed",
            False,
            "at least one tagged model is closed/API-only",
            base,
            teacher,
            lineage,
            base_key,
            teacher_key,
        )
    return Classification(
        "unknown",
        False,
        "one or more tagged models are not confirmed open-weights",
        base,
        teacher,
        lineage,
        base_key,
        teacher_key,
    )


def read_yaml(path: Path) -> dict[str, Any]:
    return yaml.safe_load(path.read_text()) or {}


def official_swe_tasks(split: str) -> dict[str, str]:
    dataset = (
        "princeton-nlp/SWE-bench_Verified" if split == "verified" else "princeton-nlp/SWE-bench"
    )
    rows = load_dataset(dataset, split="test")
    tasks = {}
    for row in rows:
        instance_id = str(row["instance_id"])
        repo = str(row["repo"])
        tasks[instance_id] = repo.split("/")[1] if "/" in repo else repo
    return tasks


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
        model_key = "; ".join(str(model) for model in models)
        engines = sorted({base_engine(str(model)) for model in models if str(model).strip()})
        engine = (
            "+".join(engines) if engines else f"system/{family_from_name(display or submission)}"
        )
        systems[submission] = SystemInfo(
            system_id=submission,
            display_name=f"{display} [{submission}]",
            base_engine=engine,
            family=family_from_name(f"{display} {submission}"),
            model_key=model_key,
        )
        y[submission] = {task_id: 1.0 if task_id in resolved else 0.0 for task_id in tasks}
    return MatrixData(
        f"swe_{split}",
        f"SWE-bench experiments {split.upper()} (system-level A-)",
        "A- system-level",
        y,
        clusters,
        systems,
        [
            (
                f"Official HF task list gives {len(tasks)} tasks; "
                "all non-resolved instances are failures."
            ),
            "Submissions restricted to IDs dated 2025-01 onward.",
        ],
    )


def load_terminalbench() -> MatrixData:
    loaded = load_dataset("yoonholee/terminalbench-trajectories")
    splits = loaded.values() if isinstance(loaded, DatasetDict) else [loaded]
    sums: dict[tuple[str, str, str], float] = defaultdict(float)
    counts: dict[tuple[str, str, str], int] = defaultdict(int)
    for split in splits:
        for row in split:
            key = (str(row["task_name"]), str(row["agent"]), str(row["model"]))
            sums[key] += float(row["reward"])
            counts[key] += 1
    all_tasks = sorted({task for task, _, _ in sums})
    min_tasks = math.ceil(0.8 * len(all_tasks))
    grouped: dict[str, dict[str, float]] = defaultdict(dict)
    trials: dict[str, int] = defaultdict(int)
    systems: dict[str, SystemInfo] = {}
    for (task, agent, model), total in sums.items():
        system_id = f"{agent} :: {model}"
        grouped[system_id][task] = total / counts[(task, agent, model)]
        trials[system_id] += counts[(task, agent, model)]
        systems[system_id] = SystemInfo(
            system_id=system_id,
            display_name=system_id,
            base_engine=base_engine(model),
            family=agent,
            model_key=model,
        )
    keep = {sid for sid, row in grouped.items() if len(row) >= min_tasks}
    y = {sid: grouped[sid] for sid in sorted(keep)}
    systems = {sid: systems[sid] for sid in sorted(keep)}
    clusters = {task: task for task in all_tasks}
    return MatrixData(
        "terminalbench",
        "Terminal-Bench trajectories (system-level A-)",
        "A- system-level",
        y,
        clusters,
        systems,
        [
            f"Repeated trials averaged per (agent, model, task); {len(all_tasks)} distinct tasks.",
            f"Kept systems with >=80% task coverage, i.e. at least {min_tasks} tasks.",
            "Pairwise dependence is Pearson correlation over fractional failure rates.",
        ],
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
        systems[model] = SystemInfo(
            system_id=model,
            display_name=model,
            base_engine=base_engine(model),
            family="llmrouterbench",
            model_key=model,
        )
        row: dict[str, float] = {}
        for record in doc.get("records") or []:
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
        y[model] = row
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
    return MatrixData(
        f"llmrouterbench_{dataset.replace('-', '')}",
        title,
        "A",
        y,
        clusters,
        systems,
        [
            (
                f"Kept model files with >=80% coverage over {len(all_tasks)} tasks; "
                "excluded OpenRouter router baseline."
            ),
            note,
        ],
    )


def combine_mbpp_humaneval(mbpp: MatrixData, humaneval: MatrixData) -> MatrixData:
    systems = {}
    y = {}
    common_systems = sorted(set(mbpp.y) & set(humaneval.y))
    clusters = {**mbpp.clusters, **humaneval.clusters}
    all_tasks = sorted(set(mbpp.clusters) | set(humaneval.clusters))
    min_tasks = math.ceil(0.8 * len(all_tasks))
    for system in common_systems:
        row = {**mbpp.y[system], **humaneval.y[system]}
        if len(row) >= min_tasks:
            y[system] = row
            systems[system] = mbpp.systems[system]
    notes = [
        "Merged LLMRouterBench MBPP and HumanEval task rows for models present in both subsets.",
        f"Kept models with >=80% coverage over {len(all_tasks)} combined tasks.",
        "No cluster metadata is present; each task is its own cluster.",
    ]
    return MatrixData(
        "mbpp_humaneval",
        "LLMRouterBench MBPP + HumanEval secondary coding subset (tier A)",
        "A",
        y,
        clusters,
        systems,
        notes,
    )


def build_domains() -> list[Domain]:
    livecodebench = load_llmrouterbench_dataset("livecodebench")
    swe_model = load_llmrouterbench_dataset("swe-bench")
    mbpp = load_llmrouterbench_dataset("mbpp")
    humaneval = load_llmrouterbench_dataset("humaneval")
    swe_verified = load_swebench("verified")
    swe_test = load_swebench("test")
    terminalbench = load_terminalbench()
    return [
        Domain(
            "algorithmic_lcb",
            "Algorithmic / LiveCodeBench (LLMRouterBench)",
            livecodebench,
            (
                "Algorithmic rows are raw model outputs, so this is the cleanest "
                "OSS field-shape signal."
            ),
        ),
        Domain(
            "mbpp_humaneval",
            "MBPP + HumanEval secondary coding (LLMRouterBench)",
            combine_mbpp_humaneval(mbpp, humaneval),
            (
                "This secondary codegen slice is easier and older than LCB, "
                "but useful for small-model complementarity."
            ),
        ),
        Domain(
            "repo_bugfix_model",
            "Repo bugfix model-level / SWE-Bench Verified (LLMRouterBench)",
            swe_model,
            "This is model-level SWE-Bench evidence without agent scaffold confounds.",
        ),
        Domain(
            "repo_bugfix_system_verified",
            "Repo bugfix system-level / SWE-bench Verified experiments",
            swe_verified,
            (
                "This is scaffold-confounded A- evidence, but it is closest to "
                "agentic bug fixing demand."
            ),
        ),
        Domain(
            "repo_bugfix_system_test",
            "Repo bugfix system-level / SWE-bench Test experiments supplement",
            swe_test,
            (
                "This supplement is scaffold-confounded and has a much smaller "
                "post-2025 submission universe."
            ),
        ),
        Domain(
            "terminal_agentic",
            "Terminal-agentic / Terminal-Bench trajectories",
            terminalbench,
            "Terminal-Bench is agent+model evidence with only 89 tasks, so phi floors often fail.",
        ),
    ]


def common_tasks(y: dict[str, dict[str, float]], systems: list[str]) -> list[str]:
    if not systems:
        return []
    return sorted(set.intersection(*(set(y[system]) for system in systems)))


def mean_on_tasks(y: dict[str, dict[str, float]], system: str, tasks: list[str]) -> float:
    return float(np.mean([y[system][task] for task in tasks])) if tasks else float("nan")


def oracle_on_tasks(y: dict[str, dict[str, float]], systems: list[str], tasks: list[str]) -> float:
    return (
        float(np.mean([max(y[system][task] for system in systems) for task in tasks]))
        if tasks
        else float("nan")
    )


def headroom_on_tasks(
    y: dict[str, dict[str, float]], systems: list[str], tasks: list[str]
) -> float:
    if not tasks:
        return float("nan")
    best = max(mean_on_tasks(y, system, tasks) for system in systems)
    return oracle_on_tasks(y, systems, tasks) - best


def pass_rate(y: dict[str, dict[str, float]], system: str) -> float:
    row = y[system]
    return float(np.mean(list(row.values()))) if row else float("nan")


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


def cluster_groups(tasks: list[str], clusters: dict[str, str]) -> dict[str, list[str]]:
    grouped: dict[str, list[str]] = defaultdict(list)
    for task in tasks:
        grouped[clusters.get(task, task)].append(task)
    return dict(grouped)


def bootstrap_clustered_ci(
    tasks: list[str],
    clusters: dict[str, str],
    metric,
    *,
    n_boot: int = BOOTSTRAPS,
    seed: int = SEED,
) -> tuple[float, float]:
    grouped = cluster_groups(tasks, clusters)
    keys = sorted(grouped)
    if not keys:
        return float("nan"), float("nan")
    rng = np.random.default_rng(seed)
    values = []
    for _ in range(n_boot):
        sampled_keys = rng.choice(keys, size=len(keys), replace=True)
        sampled_tasks = [task for key in sampled_keys for task in grouped[key]]
        values.append(metric(sampled_tasks))
    return float(np.percentile(values, 2.5)), float(np.percentile(values, 97.5))


def pairwise_dependence(data: Any, a: str, b: str) -> tuple[float | None, dict[str, Any]]:
    allow_fractional = any(
        any(abs(value - round(value)) > 1e-9 for value in row.values()) for row in data.y.values()
    )
    return pairwise_failure_dependence(
        data.y,
        a,
        b,
        allow_fractional=allow_fractional,
        min_common=PHI_MIN_COMMON,
        min_marginal=PHI_MIN_MARGINAL,
    )


def clustered_ci(data: Any, systems: list[str], metric_name: str) -> tuple[float, float]:
    tasks = common_tasks(data.y, systems)
    if metric_name == "headroom":
        return bootstrap_clustered_ci(
            tasks,
            data.clusters,
            lambda sampled: headroom_on_tasks(data.y, systems, sampled),
        )
    if metric_name == "oracle":
        return bootstrap_clustered_ci(
            tasks,
            data.clusters,
            lambda sampled: oracle_on_tasks(data.y, systems, sampled),
        )
    raise ValueError(metric_name)


def lineage_veto_pair(a: Classification, b: Classification) -> bool:
    shared_base = a.base_key != "unknown" and a.base_key and a.base_key == b.base_key
    shared_teacher = a.teacher_key and a.teacher_key == b.teacher_key
    return bool(shared_base or shared_teacher)


def veto_details(data: Any, classes: dict[str, Classification], systems: list[str]) -> list[str]:
    details = []
    for a, b in itertools.combinations(systems, 2):
        if not lineage_veto_pair(classes[a], classes[b]):
            continue
        phi, stats = pairwise_dependence(data, a, b)
        phi_text = "NA" if phi is None else f"{phi:.3f}"
        floor_text = (
            "floors met"
            if stats["floors_met"]
            else (
                f"floors not met n={stats['n_common']} marginals="
                f"{stats['fail_a']:.0f}/{stats['pass_a']:.0f},"
                f"{stats['fail_b']:.0f}/{stats['pass_b']:.0f}"
            )
        )
        details.append(
            f"{data.systems[a].display_name} <> {data.systems[b].display_name} "
            f"(shared lineage; phi={phi_text}; {floor_text})"
        )
    return details


def combo_allowed(data: Any, classes: dict[str, Classification], systems: list[str]) -> bool:
    for a, b in itertools.combinations(systems, 2):
        if not lineage_veto_pair(classes[a], classes[b]):
            continue
        phi, stats = pairwise_dependence(data, a, b)
        if phi is None or not stats["floors_met"] or phi >= LOW_PHI_ALLOW:
            return False
    return True


def phi_summary(data: Any, systems: list[str]) -> tuple[str, str]:
    values = []
    floors = []
    for a, b in itertools.combinations(systems, 2):
        phi, stats = pairwise_dependence(data, a, b)
        pair = f"{data.systems[a].display_name} / {data.systems[b].display_name}"
        values.append(f"{pair}: {'NA' if phi is None else f'{phi:.3f}'}")
        floors.append("yes" if stats["floors_met"] else "no")
    return "; ".join(values), "; ".join(floors)


def analyze_domain(domain: Domain) -> dict[str, Any]:
    data = domain.data
    classes = {
        sid: classify_system(domain.key, data.source_id, info) for sid, info in data.systems.items()
    }
    oss_ids = sorted([sid for sid, cls in classes.items() if cls.is_oss])
    closed_ids = sorted([sid for sid, cls in classes.items() if cls.label == "closed"])
    oss_common = common_tasks(data.y, oss_ids) if oss_ids else []
    field_rows = []
    if oss_ids and oss_common:
        scored = sorted(
            ((sid, mean_on_tasks(data.y, sid, oss_common)) for sid in oss_ids),
            key=lambda item: (-item[1], data.systems[item[0]].display_name),
        )
        best_score = scored[0][1]
        fifth_score = scored[4][1] if len(scored) >= 5 else scored[-1][1]
        for rank, (sid, score) in enumerate(scored, start=1):
            cls = classes[sid]
            field_rows.append(
                {
                    "domain": domain.key,
                    "rank": rank,
                    "system_id": sid,
                    "model": data.systems[sid].display_name,
                    "avg_score": round(score, 6),
                    "gap_to_1": round(best_score - score, 6),
                    "n_common": len(oss_common),
                    "tier": data.tier_label,
                    "oss_classification_note": cls.reasoning,
                    "lineage": cls.lineage,
                    "base_model": cls.base_model,
                    "teacher": cls.teacher or "none",
                }
            )
        top_gap = scored[0][1] - scored[1][1] if len(scored) >= 2 else float("nan")
        top_to_fifth = scored[0][1] - fifth_score if len(scored) >= 5 else float("nan")
    else:
        scored = []
        top_gap = float("nan")
        top_to_fifth = float("nan")
    verdict = "lopsided" if top_gap == top_gap and top_gap > 0.15 else "peer-shaped"
    if len(oss_ids) < 2:
        verdict = "insufficient OSS universe"
    shortlist = [sid for sid, _ in scored[: min(8, len(scored))]]
    panel_candidates = shortlist if shortlist else oss_ids
    panels = []
    for k in (2, 3):
        for combo in itertools.combinations(panel_candidates, k):
            combo_list = list(combo)
            if not combo_allowed(data, classes, combo_list):
                continue
            tasks = common_tasks(data.y, combo_list)
            if not tasks:
                continue
            oracle = oracle_on_tasks(data.y, combo_list, tasks)
            best_single = max(mean_on_tasks(data.y, sid, tasks) for sid in combo_list)
            headroom = oracle - best_single
            panels.append(
                {
                    "domain": domain.key,
                    "k": k,
                    "systems_list": combo_list,
                    "panel": " | ".join(data.systems[sid].display_name for sid in combo_list),
                    "base_models": " | ".join(classes[sid].base_model for sid in combo_list),
                    "teachers": " | ".join(classes[sid].teacher or "none" for sid in combo_list),
                    "n_common": len(tasks),
                    "oracle": oracle,
                    "best_single_common": best_single,
                    "headroom": headroom,
                }
            )
    panels = sorted(panels, key=lambda row: (-row["headroom"], -row["oracle"], row["panel"]))
    panel_rows = []
    for row in panels[:20]:
        systems = row["systems_list"]
        ci_low, ci_high = clustered_ci(data, systems, "headroom")
        phi_text, floors_text = phi_summary(data, systems)
        veto_text = "; ".join(veto_details(data, classes, systems))
        panel_rows.append(
            {
                "domain": domain.key,
                "k": row["k"],
                "panel_system_ids": " | ".join(systems),
                "panel": row["panel"],
                "base_models": row["base_models"],
                "teachers": row["teachers"],
                "n_common": row["n_common"],
                "oracle": round(row["oracle"], 6),
                "best_single_common": round(row["best_single_common"], 6),
                "headroom": round(row["headroom"], 6),
                "headroom_ci_low": round(ci_low, 6),
                "headroom_ci_high": round(ci_high, 6),
                "pairwise_phi": phi_text,
                "phi_floors": floors_text,
                "lineage_veto_pairs": veto_text,
                "tier": data.tier_label,
            }
        )
    closed_leader = None
    if closed_ids:
        closed_scored = sorted(
            ((sid, pass_rate(data.y, sid)) for sid in closed_ids),
            key=lambda item: (-item[1], data.systems[item[0]].display_name),
        )
        if closed_scored:
            closed_leader = {
                "system_id": closed_scored[0][0],
                "name": data.systems[closed_scored[0][0]].display_name,
                "score": closed_scored[0][1],
            }
    return {
        "domain": domain,
        "classes": classes,
        "oss_ids": oss_ids,
        "closed_ids": closed_ids,
        "field_rows": field_rows,
        "panel_rows": panel_rows,
        "shortlist": shortlist,
        "top_gap": top_gap,
        "top_to_fifth": top_to_fifth,
        "verdict": verdict,
        "closed_leader": closed_leader,
        "oss_common_n": len(oss_common),
    }


def classification_rows(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows = []
    for result in results:
        domain = result["domain"]
        data = domain.data
        for sid, info in sorted(data.systems.items(), key=lambda item: item[1].display_name):
            cls = result["classes"][sid]
            rows.append(
                {
                    "domain": domain.key,
                    "source_id": data.source_id,
                    "system_id": sid,
                    "display_name": info.display_name,
                    "family": info.family,
                    "model_key": info.model_key,
                    "base_engine_normalized": info.base_engine,
                    "classification": cls.label,
                    "is_oss": cls.is_oss,
                    "reasoning": cls.reasoning,
                    "base_model": cls.base_model,
                    "teacher": cls.teacher or "none",
                    "lineage": cls.lineage,
                    "n_tasks": len(data.y[sid]),
                    "score_all_available_tasks": round(pass_rate(data.y, sid), 6),
                }
            )
    return rows


def shortlist_rows(result: dict[str, Any]) -> list[list[Any]]:
    data = result["domain"].data
    rows = []
    for sid in result["shortlist"]:
        rank_row = next(row for row in result["field_rows"] if row["system_id"] == sid)
        veto = veto_details(
            data,
            result["classes"],
            [sid] + [other for other in result["shortlist"] if other != sid],
        )
        relevant = [item for item in veto if data.systems[sid].display_name in item]
        rows.append(
            [
                data.systems[sid].display_name,
                fmt_pct(rank_row["avg_score"]),
                result["classes"][sid].lineage,
                "; ".join(relevant) if relevant else "none",
            ]
        )
    return rows


def report_for_domain(result: dict[str, Any]) -> list[str]:
    domain = result["domain"]
    data = domain.data
    field_rows = result["field_rows"]
    panel_rows = result["panel_rows"]
    closed = result["closed_leader"]
    verdict_sentence = (
        f"Verdict: **{result['verdict']}**; OSS universe={len(result['oss_ids'])} systems, "
        f"common task set n={result['oss_common_n']}, #1-#2 gap {fmt_pp(result['top_gap'])}, "
        f"#1-#5 spread {fmt_pp(result['top_to_fifth'])}."
    )
    parts = [
        f"## {domain.title}",
        "",
        f"- Tier: {data.tier_label}.",
        f"- {domain.interpretation}",
        f"- {verdict_sentence}",
    ]
    if closed:
        parts.append(f"- Closed/frontier anchor: {closed['name']} at {fmt_pct(closed['score'])}.")
    else:
        parts.append("- Closed/frontier anchor: none identified in this source.")
    parts.append("")
    if field_rows:
        parts.extend(
            [
                "### Field shape",
                "",
                md_table(
                    ["model", "avg score", "gap to #1", "tier", "OSS classification note"],
                    [
                        [
                            row["model"],
                            fmt_pct(row["avg_score"]),
                            fmt_pp(row["gap_to_1"]),
                            row["tier"],
                            row["oss_classification_note"],
                        ]
                        for row in field_rows[:8]
                    ],
                ),
                "",
                "Interpretation: "
                + (
                    "the top OSS models are close enough for ensemble pilots."
                    if result["verdict"] == "peer-shaped"
                    else (
                        "one OSS model dominates this slice, so routing to that "
                        "model is the default."
                    )
                ),
                "",
            ]
        )
    else:
        parts.extend(
            ["### Field shape", "", "No OSS systems with adequate common coverage were found.", ""]
        )
    if panel_rows:
        top_rows = panel_rows[:5]
        parts.extend(
            [
                "### Top OSS-only panels by oracle headroom",
                "",
                md_table(
                    [
                        "K",
                        "panel",
                        "oracle",
                        "best single",
                        "headroom",
                        "95% CI",
                        "n",
                        "pairwise phi",
                    ],
                    [
                        [
                            row["k"],
                            row["panel"],
                            fmt_pct(row["oracle"]),
                            fmt_pct(row["best_single_common"]),
                            fmt_pp(row["headroom"]),
                            fmt_ci(row["headroom_ci_low"], row["headroom_ci_high"]),
                            row["n_common"],
                            row["pairwise_phi"],
                        ]
                        for row in top_rows
                    ],
                ),
                "",
                (
                    "Interpretation: the oracle is a ceiling, not an achieved "
                    "fused score; positive headroom means the members solve "
                    "different tasks."
                ),
                "",
            ]
        )
    else:
        parts.extend(
            [
                "### Top OSS-only panels by oracle headroom",
                "",
                "No K=2/3 OSS panel survives lineage-veto constraints.",
                "",
            ]
        )
    parts.extend(
        [
            "### Shortlist and lineage vetoes",
            "",
            md_table(["candidate", "avg score", "lineage", "veto flags"], shortlist_rows(result))
            if result["shortlist"]
            else "No shortlist: fewer than one OSS candidate.",
            "",
            (
                "Interpretation: veto flags mark shared ancestry/teacher pairs "
                "that should not co-occupy a pilot panel unless the reported phi "
                "is low."
            ),
            "",
        ]
    )
    return parts


def choose_pilot(results: list[dict[str, Any]]) -> dict[str, Any]:
    by_key = {result["domain"].key: result for result in results}
    priority = [
        "repo_bugfix_model",
        "repo_bugfix_system_verified",
        "algorithmic_lcb",
        "terminal_agentic",
        "mbpp_humaneval",
    ]
    for key in priority:
        result = by_key.get(key)
        if not result:
            continue
        if not result["panel_rows"] or len(result["oss_ids"]) < 3:
            continue
        if result["verdict"] == "lopsided":
            continue
        return {
            "result": result,
            "panel": result["panel_rows"][0],
            "closed": result["closed_leader"],
        }
    return {}


def panel_with_alternate(result: dict[str, Any], panel: dict[str, Any]) -> str:
    data = result["domain"].data
    classes = result["classes"]
    panel_ids = [sid for sid in panel["panel_system_ids"].split(" | ") if sid]
    names = [data.systems[sid].display_name for sid in panel_ids]
    for sid in result["shortlist"]:
        if sid in panel_ids:
            continue
        if combo_allowed(data, classes, panel_ids + [sid]):
            names.append(f"{data.systems[sid].display_name} (alternate)")
            break
    return " | ".join(names)


def write_report(results: list[dict[str, Any]]) -> None:
    pilot = choose_pilot(results)
    verdict_rows = []
    for result in results:
        best = result["panel_rows"][0] if result["panel_rows"] else None
        verdict_rows.append(
            [
                result["domain"].key,
                result["verdict"],
                len(result["oss_ids"]),
                fmt_pp(result["top_gap"]),
                "NA" if best is None else fmt_pct(best["oracle"]),
                "NA" if best is None else fmt_pp(best["headroom"]),
            ]
        )
    parts = [
        "# OSS peer-field scan",
        "",
        (
            "Public-data-only scan for OSS-first ensemble shortlists. No billed "
            "provider APIs are used; all numbers regenerate from cached/public "
            "benchmark rows."
        ),
        "",
        "## Per-domain verdicts",
        "",
        md_table(
            [
                "domain",
                "verdict",
                "OSS universe",
                "#1-#2 gap",
                "best panel oracle",
                "best panel headroom",
            ],
            verdict_rows,
        ),
        "",
        (
            "Plain-language read: peer-shaped domains with positive headroom are "
            "the best candidates for capture pilots; lopsided domains should "
            "start as single-model routing baselines."
        ),
        "",
    ]
    for result in results:
        parts.extend(report_for_domain(result))
    parts.extend(["## What this means for the capture pilot", ""])
    if pilot:
        result = pilot["result"]
        panel = pilot["panel"]
        closed = pilot["closed"]
        panel_text = panel_with_alternate(result, panel)
        parts.extend(
            [
                f"Pilot first: **{result['domain'].title}**.",
                f"Recommended 3-4 model panel seed: **{panel_text}**.",
                (
                    f"Public-data oracle/headroom: oracle {fmt_pct(panel['oracle'])}, "
                    f"headroom {fmt_pp(panel['headroom'])} CI "
                    f"{fmt_ci(panel['headroom_ci_low'], panel['headroom_ci_high'])}."
                ),
                "Frontier baseline/price anchor: "
                + (
                    f"**{closed['name']}** at {fmt_pct(closed['score'])}."
                    if closed
                    else "none available in this source."
                ),
                (
                    "Rationale: repo bugfix has the strongest launch demand and "
                    "this Tier A model-level slice shows large OSS-only headroom "
                    "without scaffold confounding; if repo patch-and-test grading "
                    "is not ready, use the LCB algorithmic panel as the fallback pilot."
                ),
                "",
            ]
        )
    else:
        parts.extend(["No domain has a viable K=3 OSS panel under the current filters.", ""])
    parts.extend(
        [
            "## Limitations",
            "",
            (
                "- SWE-bench experiments and Terminal-Bench are A- evidence: "
                "agent/scaffold differences are entangled with the model."
            ),
            (
                "- Terminal-Bench has only 89 tasks, so phi floors usually fail "
                "even when headroom is visible."
            ),
            (
                "- LLMRouterBench public rows are model-version snapshots and may "
                "be stale relative to current hosted checkpoints."
            ),
            (
                "- Lineage annotations use public/common model knowledge plus "
                "benchmark metadata; uncertain bases or teachers are explicitly marked."
            ),
            (
                "- Public priors shortlist and veto only; they do not rank "
                "production panels without a same-harness capture pilot."
            ),
            "",
        ]
    )
    (OUT / "report.md").write_text("\n".join(parts) + "\n")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    domains = build_domains()
    results = [analyze_domain(domain) for domain in domains]
    write_csv(OUT / "oss_classification.csv", classification_rows(results))
    for result in results:
        domain_key = result["domain"].key
        write_csv(OUT / f"field_shape_{domain_key}.csv", result["field_rows"])
        write_csv(OUT / f"panels_{domain_key}.csv", result["panel_rows"])
    write_report(results)
    print(f"wrote OSS scan outputs to {OUT}")
    for result in results:
        best = result["panel_rows"][0] if result["panel_rows"] else None
        if best is None:
            headroom = "NA"
            oracle = "NA"
        else:
            headroom = fmt_pp(best["headroom"])
            oracle = fmt_pct(best["oracle"])
        print(
            f"{result['domain'].key}: {result['verdict']}; "
            f"oss={len(result['oss_ids'])}; gap={fmt_pp(result['top_gap'])}; "
            f"oracle={oracle}; headroom={headroom}"
        )


if __name__ == "__main__":
    main()
