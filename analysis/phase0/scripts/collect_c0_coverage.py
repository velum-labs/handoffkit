from __future__ import annotations

import csv
import json
import re
import time
import urllib.request
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import duckdb
import yaml


ROOT = Path("/workspace")
OUT = ROOT / "analysis" / "phase0"
CACHE = OUT / "cache"
SCRIPTS = OUT / "scripts"
SWE = CACHE / "swebench-experiments" / "evaluation"
LLM_ROUTER = CACHE / "LLMRouterBench"
BIGCODE_ZIP = CACHE / "bigcodebench_sanitized_calibrated_samples_v0.2.5.zip"
BIGCODE_DEEPCODER_ZIP = CACHE / "bigcodebench_deepcoder_v0.2.5.zip"


DEPLOYABLE_RELEASE_NOTES = {
    "openai/gpt-5 family": "GPT-5 public series began 2025-08; catalog also lists 5.1/5.3/5.5/Codex variants, latest dates uncertain/catalog-derived.",
    "openai/gpt-4.1 family": "2025-04 approximate.",
    "openai/o4-mini": "2025-04 approximate.",
    "anthropic/claude-sonnet-4 family": "Claude Sonnet 4 began 2025-05; 4.5/4.6 catalog variants are late-2025/early-2026 uncertain.",
    "anthropic/claude-opus-4 family": "Claude Opus 4 began 2025-05; 4.5/4.8 catalog variants are late-2025/early-2026 uncertain.",
    "anthropic/claude-haiku-4 family": "Haiku 4.5 catalog variant, approximate late-2025; uncertain.",
    "anthropic/claude-3.7-sonnet": "2025-02 approximate.",
    "google/gemini-3-pro": "Catalog/benchmark frontier variant, approximate late-2025; uncertain.",
    "google/gemini-2.5-pro": "2025-03/2025-04 approximate.",
    "google/gemini-2.5-flash": "2025-04 approximate.",
    "google/gemini-2.0-flash": "2024-12 preview / 2025-02 GA approximate.",
    "moonshot/kimi-k2 family": "Kimi K2 began 2025-07; thinking variant later, uncertain.",
    "qwen/qwen3-coder family": "Qwen3-Coder 480B family, 2025-07 approximate.",
    "deepseek/deepseek-v3-chat": "DeepSeek-V3/chat family, 2024-12/2025-03 approximate.",
    "xai/grok-4": "2025-07 approximate.",
    "meta/llama-3.3-70b-instruct": "2024-12 approximate.",
    "qwen/qwen3-local-small": "Qwen3 small local model family, 2025-04 approximate.",
}


def http_json(url: str) -> Any:
    with urllib.request.urlopen(url, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def normalize(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def base_group(model: str) -> str | None:
    raw = model.lower()
    n = normalize(model)
    if "gpt-4-1" in n:
        return "openai/gpt-4.1 family"
    if "o4-mini" in n or "o4mini" in n:
        return "openai/o4-mini"
    if "gpt-5" in n or re.search(r"\bgpt5\b", n):
        return "openai/gpt-5 family"
    if "claude" in n and "sonnet" in n and "3-7" in n:
        return "anthropic/claude-3.7-sonnet"
    if (
        ("claude-sonnet-4" in n or "claude-4-sonnet" in n or "claude-v4" in n)
        and "sonnet" in n
    ):
        return "anthropic/claude-sonnet-4 family"
    if "claude-v4" in n:
        return "anthropic/claude-sonnet-4 family"
    if "claude-opus-4" in n or "claude-4-opus" in n:
        return "anthropic/claude-opus-4 family"
    if "claude-haiku-4" in n or "claude-4-haiku" in n:
        return "anthropic/claude-haiku-4 family"
    if "gemini-3" in n:
        return "google/gemini-3-pro"
    if "gemini-2-5-pro" in n or "gemini-pro" in n:
        return "google/gemini-2.5-pro"
    if "gemini-2-5-flash" in n or "gemini-flash" in n:
        return "google/gemini-2.5-flash"
    if "gemini-2-0-flash" in n:
        return "google/gemini-2.0-flash"
    if "kimi-k2" in n:
        return "moonshot/kimi-k2 family"
    if "qwen3-coder" in n or "qwen-3-coder" in n:
        return "qwen/qwen3-coder family"
    if "qwen3-1-7b" in n or "qwen3-1-7" in n:
        return "qwen/qwen3-local-small"
    if ("deepseek" in n and ("v3" in n or "v3-1" in n)) or "deepseek-chat" in n:
        return "deepseek/deepseek-v3-chat"
    if "grok-4" in n:
        return "xai/grok-4"
    if "llama-3-3-70b" in n:
        return "meta/llama-3.3-70b-instruct"
    return None


def extract_deployables() -> list[dict[str, str]]:
    catalog = json.loads((ROOT / "spec" / "registry" / "model-catalog.json").read_text())
    fusion = json.loads((ROOT / ".fusionkit" / "fusion.json").read_text())
    mc = catalog["modelCatalog"]
    rows: dict[tuple[str, str], dict[str, str]] = {}

    def add(model: str, provider: str, source: str) -> None:
        key = (provider, model)
        group = base_group(model) or f"{provider}/{model}"
        if key not in rows:
            rows[key] = {
                "provider": provider,
                "model": model,
                "base_group": group,
                "sources": source,
            }
        elif source not in rows[key]["sources"].split("; "):
            rows[key]["sources"] += f"; {source}"

    for member in mc["defaultCloudPanel"]:
        add(member["model"], member["provider"], "modelCatalog.defaultCloudPanel")
    auth_provider = {
        "claude-code": "anthropic",
        "anthropic": "anthropic",
        "codex": "codex",
        "openai": "openai",
        "google": "google",
        "openrouter": "openrouter",
        "local": "local",
    }
    for auth, model in mc["defaultModelByAuthChoice"].items():
        add(model, auth_provider.get(auth, auth), f"modelCatalog.defaultModelByAuthChoice.{auth}")
    for provider, models in mc["curated"].items():
        mapped = auth_provider.get(provider, provider)
        for model in models:
            add(model, mapped, f"modelCatalog.curated.{provider}")
    for provider, model in mc["smokeModels"].items():
        add(model, provider, f"modelCatalog.smokeModels.{provider}")
    for panel_id, preset in mc["benchmarkPanels"].items():
        for member in preset["members"]:
            add(member["model"], member["provider"], f"modelCatalog.benchmarkPanels.{panel_id}")
    for member in fusion["panel"]:
        add(member["model"], member["provider"], ".fusionkit/fusion.json.panel")
    if "judgeModel" in fusion:
        add(fusion["judgeModel"], "openrouter", ".fusionkit/fusion.json.judgeModel")
    return sorted(rows.values(), key=lambda r: (r["base_group"], r["provider"], r["model"]))


def split_size(split: str) -> int:
    return {"lite": 300, "verified": 500, "test": 2294}.get(split, 0)


def read_yaml(path: Path) -> dict[str, Any]:
    return yaml.safe_load(path.read_text()) or {}


def collect_swebench() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for metadata in sorted(SWE.glob("*/*/metadata.yaml")):
        split = metadata.parts[-3]
        submission = metadata.parent.name
        doc = read_yaml(metadata)
        models = doc.get("tags", {}).get("model") or []
        if isinstance(models, str):
            models = [models]
        display_name = doc.get("info", {}).get("name") or submission
        result_path = metadata.parent / "results" / "results.json"
        result = json.loads(result_path.read_text()) if result_path.exists() else {}
        resolved = set(result.get("resolved", []))
        mentioned = set()
        for value in result.values():
            if isinstance(value, list):
                mentioned.update(x for x in value if isinstance(x, str))
        date_match = re.match(r"(\d{8})", submission)
        date = date_match.group(1) if date_match else ""
        groups = sorted({base_group(m) for m in models if base_group(m)})
        rows.append(
            {
                "split": split,
                "submission": submission,
                "display_name": display_name,
                "model_keys": "; ".join(models),
                "base_groups": "; ".join(groups),
                "date": date,
                "n_instances_reported": split_size(split) or len(mentioned),
                "n_instances_reported_note": "split-size fallback; prediction files not materialized in sparse checkout",
                "n_resolved": len(resolved),
                "deployable_match": bool(groups),
            }
        )
    return rows


def collect_llmrouterbench() -> list[dict[str, Any]]:
    # Exact row counts are from README tables: flagship code subset is
    # LiveCodeBench 1055 + SWE-Bench 500; lightweight code subset is
    # HumanEval 164 + MBPP 974 + LiveCodeBench 1055. The 1.28 GB result bundle
    # is listed on HF but intentionally not downloaded for C0.
    flagship = [
        "Claude-sonnet-4",
        "Gemini-2.5-flash",
        "Gemini-2.5-pro",
        "GPT-5-chat",
        "GPT-5-medium",
        "Qwen3-235b-a22b-2507",
        "Qwen3-235b-a22b-thinking-2507",
        "Deepseek-v3-0324",
        "Deepseek-v3.1-terminus",
        "Deepseek-r1-0528",
        "GLM-4.6",
        "Kimi-k2-0905",
        "Intern-s1",
    ]
    lightweight = [
        "DeepHermes-3-Llama-3-8B-Preview",
        "DeepSeek-R1-0528-Qwen3-8B",
        "DeepSeek-R1-Distill-Qwen-7B",
        "Fin-R1",
        "GLM-Z1-9B-0414",
        "Intern-S1-mini",
        "Llama-3.1-8B-Instruct",
        "Llama-3.1-8B-UltraMedical",
        "Llama-3.1-Nemotron-Nano-8B-v1",
        "MiMo-7B-RL-0530",
        "MiniCPM4.1-8B",
        "NVIDIA-Nemotron-Nano-9B-v2",
        "OpenThinker3-7B",
        "Qwen2.5-Coder-7B-Instruct",
        "Qwen3-8B",
        "Cogito-v1-preview-llama-8B",
        "Gemma-2-9b-it",
        "Glm-4-9b-chat",
        "Granite-3.3-8b-instruct",
        "Internlm3-8b-instruct",
    ]
    rows = []
    for model in flagship:
        rows.append(
            {
                "model": model,
                "pool": "performance-cost",
                "base_group": base_group(model) or "",
                "coding_rows": 1555,
                "datasets": "LiveCodeBench=1055; SWE-Bench=500",
                "freshness": "README Apr 2026 / HF bundle current at collection",
            }
        )
    for model in lightweight:
        rows.append(
            {
                "model": model,
                "pool": "performance",
                "base_group": base_group(model) or "",
                "coding_rows": 2193,
                "datasets": "HumanEval=164; MBPP=974; LiveCodeBench=1055",
                "freshness": "README Apr 2026 / HF bundle current at collection",
            }
        )
    return rows


def parquet_urls(dataset: str) -> tuple[dict[str, Any], list[str]]:
    info = http_json(f"https://datasets-server.huggingface.co/info?dataset={dataset}")
    files = http_json(f"https://datasets-server.huggingface.co/parquet?dataset={dataset}")
    return info, [f["url"] for f in files["parquet_files"]]


def collect_livebench() -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    info, urls = parquet_urls("livebench%2Fmodel_judgment")
    con = duckdb.connect()
    total = con.sql(
        "select count(*) total, count(distinct model) models from read_parquet(?)",
        params=[urls],
    ).fetchone()
    cats = [
        {"category": category, "rows": rows}
        for category, rows in con.sql(
            "select category, count(*) from read_parquet(?) group by 1 order by 2 desc",
            params=[urls],
        ).fetchall()
    ]
    rows = []
    for model, total_rows, coding_rows, latest in con.sql(
        "select model, count(*) total_rows, sum(case when category='coding' then 1 else 0 end) coding_rows, max(tstamp) latest "
        "from read_parquet(?) group by 1 order by model",
        params=[urls],
    ).fetchall():
        rows.append(
            {
                "model": model,
                "base_group": base_group(model) or "",
                "total_rows": int(total_rows),
                "coding_rows": int(coding_rows or 0),
                "latest_utc": datetime.fromtimestamp(float(latest), tz=timezone.utc).date().isoformat()
                if latest
                else "",
            }
        )
    summary = {
        "total_rows": int(total[0]),
        "distinct_models": int(total[1]),
        "split_examples": info["dataset_info"]["default"]["splits"]["leaderboard"]["num_examples"],
        "parquet_urls": urls,
    }
    return summary, cats, rows


def collect_terminalbench() -> tuple[dict[str, Any], list[dict[str, Any]]]:
    info, urls = parquet_urls("yoonholee%2Fterminalbench-trajectories")
    con = duckdb.connect()
    total = con.sql(
        "select count(*) total, count(distinct model) models, count(distinct agent) agents from read_parquet(?)",
        params=[urls],
    ).fetchone()
    rows = []
    for agent, model, n, latest in con.sql(
        "select agent, model, count(*) row_count, max(started_at) latest from read_parquet(?) group by 1,2 order by 3 desc",
        params=[urls],
    ).fetchall():
        rows.append(
            {
                "agent": agent,
                "model": model,
                "base_group": base_group(model) or "",
                "rows": int(n),
                "latest_utc": latest or "",
            }
        )
    summary = {
        "total_rows": int(total[0]),
        "distinct_models": int(total[1]),
        "distinct_agents": int(total[2]),
        "split_examples": info["dataset_info"]["default"]["splits"]["train"]["num_examples"],
        "parquet_urls": urls,
    }
    return summary, rows


def model_from_bigcode_name(path: str) -> tuple[str, str]:
    name = Path(path).name
    if "--bigcodebench-" not in name:
        return "", ""
    model = name.split("--bigcodebench-", 1)[0]
    suite = "bigcodebench-" + name.split("--bigcodebench-", 1)[1].split("--", 1)[0]
    return model, suite


def collect_bigcodebench() -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    releases = http_json("https://api.github.com/repos/bigcode-project/bigcodebench/releases")
    assets = []
    for rel in releases:
        for asset in rel.get("assets") or []:
            assets.append(
                {
                    "tag": rel.get("tag_name"),
                    "published_at": rel.get("published_at"),
                    "name": asset.get("name"),
                    "size": asset.get("size"),
                    "url": asset.get("browser_download_url"),
                }
            )
    rows_by_model: Counter[tuple[str, str]] = Counter()
    archive_files: list[dict[str, Any]] = []
    for zip_path in [BIGCODE_ZIP, BIGCODE_DEEPCODER_ZIP]:
        if not zip_path.exists():
            continue
        with zipfile.ZipFile(zip_path) as zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                model, suite = model_from_bigcode_name(info.filename)
                if not model:
                    continue
                suffix = Path(info.filename).suffix
                is_outcome = suffix == ".jsonl" or info.filename.endswith("_eval_results.json")
                if is_outcome:
                    if suffix == ".jsonl":
                        with zf.open(info) as handle:
                            count = sum(1 for _ in handle)
                    else:
                        data = json.loads(zf.read(info).decode("utf-8"))
                        count = len(data) if isinstance(data, dict) else 0
                    rows_by_model[(model, suite)] += count
                archive_files.append(
                    {
                        "archive": zip_path.name,
                        "path": info.filename,
                        "model": model,
                        "suite": suite,
                        "size": info.file_size,
                    }
                )
    model_rows = []
    for (model, suite), rows in sorted(rows_by_model.items()):
        model_rows.append(
            {
                "model": model,
                "suite": suite,
                "base_group": base_group(model) or "",
                "rows": int(rows),
                "freshness": "v0.2.5 published 2025-04-11",
            }
        )
    return assets, archive_files, model_rows


def aggregate_by_group(
    deployables: list[dict[str, str]],
    swe_rows: list[dict[str, Any]],
    llm_rows: list[dict[str, Any]],
    live_rows: list[dict[str, Any]],
    big_rows: list[dict[str, Any]],
    term_rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    groups: dict[str, dict[str, Any]] = {}
    by_group_models: defaultdict[str, list[str]] = defaultdict(list)
    by_group_providers: defaultdict[str, set[str]] = defaultdict(set)
    by_group_sources: defaultdict[str, set[str]] = defaultdict(set)
    for dep in deployables:
        group = dep["base_group"]
        by_group_models[group].append(dep["model"])
        by_group_providers[group].add(dep["provider"])
        by_group_sources[group].update(dep["sources"].split("; "))

    for group in sorted(by_group_models):
        groups[group] = {
            "base_group": group,
            "providers": ", ".join(sorted(by_group_providers[group])),
            "deployable_models": "; ".join(sorted(set(by_group_models[group]))),
            "release_note": DEPLOYABLE_RELEASE_NOTES.get(group, "Unknown/uncertain."),
            "catalog_sources": "; ".join(sorted(by_group_sources[group])),
            "swebench_rows": 0,
            "swebench_latest": "",
            "swebench_submissions": 0,
            "llmrouterbench_rows": 0,
            "llmrouterbench_models": "",
            "livebench_total_rows": 0,
            "livebench_coding_rows": 0,
            "livebench_latest": "",
            "bigcodebench_rows": 0,
            "bigcodebench_models": "",
            "terminalbench_rows": 0,
            "terminalbench_latest": "",
            "terminalbench_systems": 0,
        }

    for row in swe_rows:
        for group in row["base_groups"].split("; "):
            if group in groups:
                groups[group]["swebench_rows"] += int(row["n_instances_reported"])
                groups[group]["swebench_submissions"] += 1
                groups[group]["swebench_latest"] = max(groups[group]["swebench_latest"], row["date"])

    llm_models_by_group: defaultdict[str, list[str]] = defaultdict(list)
    for row in llm_rows:
        group = row["base_group"]
        if group in groups:
            groups[group]["llmrouterbench_rows"] += int(row["coding_rows"])
            llm_models_by_group[group].append(row["model"])
    for group, models in llm_models_by_group.items():
        groups[group]["llmrouterbench_models"] = "; ".join(sorted(models))

    for row in live_rows:
        group = row["base_group"]
        if group in groups:
            groups[group]["livebench_total_rows"] += int(row["total_rows"])
            groups[group]["livebench_coding_rows"] += int(row["coding_rows"])
            groups[group]["livebench_latest"] = max(groups[group]["livebench_latest"], row["latest_utc"])

    big_models_by_group: defaultdict[str, list[str]] = defaultdict(list)
    for row in big_rows:
        group = row["base_group"]
        if group in groups:
            groups[group]["bigcodebench_rows"] += int(row["rows"])
            big_models_by_group[group].append(f"{row['model']}:{row['suite']}")
    for group, models in big_models_by_group.items():
        groups[group]["bigcodebench_models"] = "; ".join(sorted(set(models))[:10])

    for row in term_rows:
        group = row["base_group"]
        if group in groups:
            groups[group]["terminalbench_rows"] += int(row["rows"])
            groups[group]["terminalbench_systems"] += 1
            groups[group]["terminalbench_latest"] = max(groups[group]["terminalbench_latest"], row["latest_utc"])

    return list(groups.values())


def top_systems(
    swe_rows: list[dict[str, Any]],
    llm_rows: list[dict[str, Any]],
    live_rows: list[dict[str, Any]],
    big_rows: list[dict[str, Any]],
    term_rows: list[dict[str, Any]],
    deployable_groups: set[str],
) -> list[dict[str, Any]]:
    systems = []
    for row in sorted(swe_rows, key=lambda r: r["n_resolved"], reverse=True)[:12]:
        systems.append(
            {
                "source": "SWE-bench experiments",
                "system": row["display_name"],
                "model": row["model_keys"],
                "rows": row["n_instances_reported"],
                "freshness": row["date"],
                "why": f"{row['split']} split; resolved={row['n_resolved']}",
            }
        )
    for row in sorted(llm_rows, key=lambda r: r["coding_rows"], reverse=True):
        if row["base_group"] not in deployable_groups:
            systems.append(
                {
                    "source": "LLMRouterBench",
                    "system": row["model"],
                    "model": row["model"],
                    "rows": row["coding_rows"],
                    "freshness": row["freshness"],
                    "why": row["datasets"],
                }
            )
        if len([s for s in systems if s["source"] == "LLMRouterBench"]) >= 8:
            break
    for row in sorted(live_rows, key=lambda r: (r["coding_rows"], r["total_rows"]), reverse=True):
        if row["base_group"] not in deployable_groups:
            systems.append(
                {
                    "source": "LiveBench",
                    "system": row["model"],
                    "model": row["model"],
                    "rows": row["total_rows"],
                    "freshness": row["latest_utc"],
                    "why": f"coding rows={row['coding_rows']}",
                }
            )
        if len([s for s in systems if s["source"] == "LiveBench"]) >= 8:
            break
    for row in sorted(big_rows, key=lambda r: r["rows"], reverse=True):
        if row["base_group"] not in deployable_groups:
            systems.append(
                {
                    "source": "BigCodeBench",
                    "system": row["model"],
                    "model": row["model"],
                    "rows": row["rows"],
                    "freshness": row["freshness"],
                    "why": row["suite"],
                }
            )
        if len([s for s in systems if s["source"] == "BigCodeBench"]) >= 8:
            break
    for row in sorted(term_rows, key=lambda r: r["rows"], reverse=True):
        if row["base_group"] not in deployable_groups:
            systems.append(
                {
                    "source": "Terminal-Bench",
                    "system": row["agent"],
                    "model": row["model"],
                    "rows": row["rows"],
                    "freshness": row["latest_utc"][:10],
                    "why": "agent/model trials",
                }
            )
        if len([s for s in systems if s["source"] == "Terminal-Bench"]) >= 8:
            break
    return systems


def cell_count(value: int, note: str = "") -> str:
    if value == 0:
        return "0"
    return f"{value:,}{note}"


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def md_table(headers: list[str], rows: list[list[str]]) -> str:
    out = ["| " + " | ".join(headers) + " |", "| " + " | ".join(["---"] * len(headers)) + " |"]
    for row in rows:
        out.append("| " + " | ".join(str(cell).replace("\n", " ") for cell in row) + " |")
    return "\n".join(out)


def write_report(
    deployables: list[dict[str, str]],
    groups: list[dict[str, Any]],
    swe_rows: list[dict[str, Any]],
    llm_rows: list[dict[str, Any]],
    live_summary: dict[str, Any],
    live_categories: list[dict[str, Any]],
    big_assets: list[dict[str, Any]],
    big_archive_files: list[dict[str, Any]],
    term_summary: dict[str, Any],
    systems: list[dict[str, Any]],
) -> None:
    tier_groups = [
        row
        for row in groups
        if row["swebench_rows"]
        or row["llmrouterbench_rows"]
        or row["livebench_coding_rows"]
        or row["bigcodebench_rows"]
        or row["terminalbench_rows"]
    ]
    dense_deployable = [
        row
        for row in groups
        if row["swebench_rows"] >= 1000
        or row["llmrouterbench_rows"] >= 1000
        or row["terminalbench_rows"] >= 1000
    ]
    verdict = (
        "PARTIAL: deployable frontier has meaningful A/A- per-task coverage, but it is uneven and largely "
        "source-dependent. Terminal-Bench and SWE-bench cover several current agentic/code frontier families; "
        "LLMRouterBench covers GPT-5/Claude-4/Gemini-2.5/Kimi/DeepSeek in a same-framework routing corpus; "
        "LiveBench/BigCodeBench lag the newest deployables. Proceed to C1/C2 on dense systems, but do not "
        "treat public priors as sufficient for final deployable panel selection without C3 calibration."
        if dense_deployable
        else "NO: deployable frontier lacks tier-A/A- per-task coverage; descope to shortlisting + calibration."
    )
    coverage_rows = []
    for row in groups:
        coverage_rows.append(
            [
                row["base_group"],
                row["providers"],
                row["deployable_models"],
                row["release_note"],
                cell_count(row["swebench_rows"], f" ({row['swebench_submissions']} submissions; latest {row['swebench_latest']})" if row["swebench_rows"] else ""),
                cell_count(row["llmrouterbench_rows"], f" ({row['llmrouterbench_models']})" if row["llmrouterbench_rows"] else ""),
                cell_count(row["livebench_total_rows"], f" ({row['livebench_coding_rows']:,} coding; latest {row['livebench_latest']})" if row["livebench_total_rows"] else ""),
                cell_count(row["bigcodebench_rows"], f" ({row['bigcodebench_models']})" if row["bigcodebench_rows"] else ""),
                cell_count(row["terminalbench_rows"], f" ({row['terminalbench_systems']} systems; latest {row['terminalbench_latest'][:10]})" if row["terminalbench_rows"] else ""),
            ]
        )
    systems_rows = [
        [s["source"], s["system"], s["model"], f"{s['rows']:,}", s["freshness"], s["why"]]
        for s in systems
    ]
    deployable_rows = [
        [d["provider"], d["model"], d["base_group"], d["sources"]]
        for d in deployables
    ]
    live_cat_text = ", ".join(f"{c['category']}={c['rows']:,}" for c in live_categories)
    eval_asset_count = sum(1 for f in big_archive_files if f["path"].endswith("_eval_results.json"))
    content = f"""# C0 deployable-model public coverage

Generated: {datetime.now(timezone.utc).isoformat(timespec="seconds")}

## C0 verdict

{verdict}

Recommended C1/C2 source: **Terminal-Bench first for deployable agentic coverage**, with **LLMRouterBench** as the clean same-framework method-validation fallback. SWE-bench is valuable but scaffold-confounded; use it to validate repo-bugfix complementarity across strong systems, not as raw model truth.

## Deployable coverage table

Cells are public per-task/per-instance outcome rows. SWE-bench and Terminal-Bench rows are A- because they are agent/scaffold-confounded. LLMRouterBench and BigCodeBench rows are code-subset/sample outcome rows. LiveBench cells show total rows with coding rows in parentheses.

{md_table(["Base deployable engine", "Providers", "Deployable model IDs", "Approx release / uncertainty", "SWE-bench experiments", "LLMRouterBench coding", "LiveBench", "BigCodeBench", "Terminal-Bench"], coverage_rows)}

## Systems coverage table: dense non-deployable systems

These rows are useful for C1/C2 method validation even when they are not deployable endpoints in this product catalog.

{md_table(["Source", "System", "Model key", "Rows", "Freshness", "Notes"], systems_rows)}

## Deployable list extracted from repo

{md_table(["Provider", "Model", "Base group", "Repo source(s)"], deployable_rows)}

## Source notes

- SWE-bench experiments: parsed {len(swe_rows):,} submission directories from `evaluation/{{lite,verified,test}}`; result files expose resolved IDs. Prediction files were not materialized by the sparse checkout, so `n_instances_reported` uses the split size fallback (lite=300, verified=500, test=2,294).
- LLMRouterBench: repo clone has no checked-in result JSON under `results/bench`; README points to a 1.28 GB HF `bench-release.tar.gz`. For C0 I used the README model pools and dataset-size tables without downloading the bundle. Coding coverage is 1,555 rows per flagship model (LiveCodeBench 1,055 + SWE-Bench 500) and 2,193 rows per lightweight model (HumanEval 164 + MBPP 974 + LiveCodeBench 1,055).
- LiveBench: HF `livebench/model_judgment` reports {live_summary['total_rows']:,} rows, {live_summary['distinct_models']:,} models, categories {live_cat_text}. Coding is the main relevant category for this study.
- BigCodeBench: GitHub releases API listed {len(big_assets):,} top-level assets. The latest top-level assets are zips rather than bare `*_eval_results.json`; `deepcoder.zip` contains {eval_asset_count:,} explicit `_eval_results.json` files, and `sanitized_calibrated_samples.zip` contains per-model calibrated JSONL outcome samples. It has deployable-adjacent rows for DeepSeek/Gemini/Llama families, but lags the newest GPT-5/Claude-4/Kimi/Qwen3-Coder/Gemini-3 frontier.
- Terminal-Bench: HF `yoonholee/terminalbench-trajectories` reports {term_summary['total_rows']:,} rows, {term_summary['distinct_models']:,} model strings, {term_summary['distinct_agents']:,} agents. This is the strongest deployable-frontier source found.

## Methods and commands / URLs

- Read spec sections: `/workspace/docs/fusion/capability-index-spec.md` lines 617-716 and 1597-1645.
- Read deployable repo sources: `/workspace/spec/registry/model-catalog.json`, `/workspace/python/fusionkit-core/src/fusionkit_core/registry.py` via `BENCHMARK_PANEL_PRESETS`, and `/workspace/.fusionkit/fusion.json`.
- Created `/workspace/analysis/phase0/cache` and `/workspace/analysis/phase0/scripts`.
- SWE-bench: `git clone --depth 1 --filter=blob:none --sparse https://github.com/swe-bench/experiments /workspace/analysis/phase0/cache/swebench-experiments` then `git -C ... sparse-checkout set evaluation/lite evaluation/verified evaluation/test`.
- LLMRouterBench: `git clone --depth 1 https://github.com/ynulihao/LLMRouterBench /workspace/analysis/phase0/cache/LLMRouterBench`; queried `https://huggingface.co/api/datasets/NPULH/LLMRouterBench/tree/main?recursive=true` and read README/download notes.
- LiveBench: queried `https://datasets-server.huggingface.co/info?dataset=livebench%2Fmodel_judgment`, `/first-rows?dataset=livebench%2Fmodel_judgment&config=default&split=leaderboard`, and `/parquet?dataset=livebench%2Fmodel_judgment`; used DuckDB over the parquet URL.
- BigCodeBench: queried `https://api.github.com/repos/bigcode-project/bigcodebench/releases`; downloaded release assets `sanitized_calibrated_samples.zip` and `deepcoder.zip` into cache and enumerated them with Python `zipfile`.
- Terminal-Bench: queried `https://datasets-server.huggingface.co/info?dataset=yoonholee%2Fterminalbench-trajectories`, `/first-rows?dataset=yoonholee%2Fterminalbench-trajectories&config=default&split=train`, and `/parquet?dataset=yoonholee%2Fterminalbench-trajectories`; used DuckDB over the parquet URLs.
- Collector command: `uv run --with pyyaml --with duckdb python /workspace/analysis/phase0/scripts/collect_c0_coverage.py`.

## Access failures / limitations

- LiveBench `/first-rows` with `split=train` returned 404; corrected to `split=leaderboard`.
- LLMRouterBench result bundle is 1.28 GB and was not downloaded; counts use README/HF manifest model-pool and dataset-size evidence.
- SWE-bench sparse checkout did not materialize `all_preds.jsonl`; row counts use known split sizes and resolved-list counts.
- BigCodeBench release API did not expose top-level bare `*_eval_results.json` assets; explicit eval-result JSONs were inside `deepcoder.zip`.
"""
    (OUT / "c0_coverage.md").write_text(content)


def main() -> None:
    start = time.time()
    deployables = extract_deployables()
    swe_rows = collect_swebench()
    llm_rows = collect_llmrouterbench()
    live_summary, live_categories, live_rows = collect_livebench()
    term_summary, term_rows = collect_terminalbench()
    big_assets, big_archive_files, big_rows = collect_bigcodebench()
    groups = aggregate_by_group(deployables, swe_rows, llm_rows, live_rows, big_rows, term_rows)
    deployable_groups = {d["base_group"] for d in deployables}
    systems = top_systems(swe_rows, llm_rows, live_rows, big_rows, term_rows, deployable_groups)

    write_csv(OUT / "deployable_models.csv", deployables)
    write_csv(OUT / "deployable_group_coverage.csv", groups)
    write_csv(OUT / "swebench_submissions.csv", swe_rows)
    write_csv(OUT / "llmrouterbench_model_rows.csv", llm_rows)
    write_csv(OUT / "livebench_model_rows.csv", live_rows)
    write_csv(OUT / "terminalbench_model_agent_rows.csv", term_rows)
    write_csv(OUT / "bigcodebench_release_assets.csv", big_assets)
    write_csv(OUT / "bigcodebench_model_rows.csv", big_rows)
    (OUT / "c0_raw_summary.json").write_text(
        json.dumps(
            {
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "elapsed_seconds": round(time.time() - start, 2),
                "livebench": live_summary,
                "livebench_categories": live_categories,
                "terminalbench": term_summary,
                "counts": {
                    "deployable_models": len(deployables),
                    "deployable_groups": len(groups),
                    "swebench_submissions": len(swe_rows),
                    "llmrouterbench_models": len(llm_rows),
                    "livebench_models": len(live_rows),
                    "terminalbench_agent_models": len(term_rows),
                    "bigcodebench_release_assets": len(big_assets),
                    "bigcodebench_model_suites": len(big_rows),
                },
            },
            indent=2,
        )
    )
    write_report(
        deployables,
        groups,
        swe_rows,
        llm_rows,
        live_summary,
        live_categories,
        big_assets,
        big_archive_files,
        term_summary,
        systems,
    )
    print(f"wrote {OUT / 'c0_coverage.md'}")
    print(json.dumps(json.loads((OUT / "c0_raw_summary.json").read_text())["counts"], indent=2))


if __name__ == "__main__":
    main()
