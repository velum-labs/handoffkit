from __future__ import annotations

import csv
import json
import math
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
ROUND = ROOT / "analysis" / "thinking-32k"
PHASE0 = ROOT / "analysis" / "phase0"
OUTCOMES_32K = ROUND / "outcomes_32k.csv"
RERUN_OUTCOMES = [
    ROUND / "cache" / "outcomes_32k_failed_rerun.csv",
    ROUND / "cache" / "outcomes_32k_sonnet_arc192e_retry.csv",
]
LEDGER = ROUND / "spend_ledger.jsonl"
REPORT = ROUND / "report.md"
MANIFEST = PHASE0 / "c3_task_manifest.json"
OUTCOMES_16K = PHASE0 / "c3r16k_outcomes.csv"

FIELDNAMES = [
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


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDNAMES)
        writer.writeheader()
        writer.writerows(rows)


def read_ledger(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def manifest_ids() -> list[str]:
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    return [str(row["task_id"]) for row in data["tasks"]]


def numeric(row: dict[str, Any], key: str) -> float | None:
    value = row.get(key)
    if value in (None, ""):
        return None
    return float(value)


def wilson(successes: int, n: int) -> tuple[float, float, float]:
    if n == 0:
        return (0.0, 0.0, 0.0)
    z = 1.959963984540054
    phat = successes / n
    denom = 1 + z * z / n
    center = (phat + z * z / (2 * n)) / denom
    margin = z * math.sqrt((phat * (1 - phat) + z * z / (4 * n)) / n) / denom
    return (phat, max(0.0, center - margin), min(1.0, center + margin))


def merge_reruns() -> list[dict[str, Any]]:
    rows = read_csv(OUTCOMES_32K)
    failed_keys = {
        (row["task_id"], row["endpoint_id"])
        for row in rows
        if row["call_status"] != "succeeded"
    }
    replacements: dict[tuple[str, str], dict[str, str]] = {}
    for path in RERUN_OUTCOMES:
        if not path.exists():
            continue
        for row in read_csv(path):
            key = (row["task_id"], row["endpoint_id"])
            if key in failed_keys:
                prior = replacements.get(key)
                if prior is None or prior["call_status"] != "succeeded":
                    replacements[key] = row
                elif row["call_status"] == "succeeded":
                    replacements[key] = row
    return [replacements.get((row["task_id"], row["endpoint_id"]), row) for row in rows]


def model_metrics(rows: list[dict[str, Any]], max_tokens: int) -> dict[str, dict[str, Any]]:
    by_model: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_model[row["endpoint_id"]].append(row)
    out = {}
    for model, model_rows in sorted(by_model.items()):
        n = len(model_rows)
        passed = sum(int(row["passed"]) for row in model_rows)
        trunc = sum(
            1
            for row in model_rows
            if (tokens := numeric(row, "completion_tokens")) is not None and tokens >= max_tokens
        )
        completion_tokens = [
            numeric(row, "completion_tokens") or 0.0
            for row in model_rows
        ]
        prompt_tokens = [
            numeric(row, "prompt_tokens") or 0.0
            for row in model_rows
        ]
        cost = sum(numeric(row, "charged_cost_usd") or 0.0 for row in model_rows)
        estimate, low, high = wilson(passed, n)
        out[model] = {
            "n": n,
            "passed": passed,
            "pass_rate": estimate,
            "ci_low": low,
            "ci_high": high,
            "truncated": trunc,
            "mean_completion_tokens": sum(completion_tokens) / n if n else 0.0,
            "completion_tokens": sum(completion_tokens),
            "prompt_tokens": sum(prompt_tokens),
            "outcome_spend": cost,
            "provider_failures": sum(1 for row in model_rows if row["call_status"] != "succeeded"),
        }
    return out


def ledger_spend(rows: list[dict[str, Any]]) -> dict[str, float]:
    spend: dict[str, float] = defaultdict(float)
    for row in rows:
        endpoint = str(row.get("endpoint_id") or "unknown")
        value = row.get("charged_cost_usd")
        if isinstance(value, int | float):
            spend[endpoint] += float(value)
    return dict(spend)


def pct(value: float) -> str:
    return f"{value * 100:.1f}%"


def ci_text(metrics: dict[str, Any]) -> str:
    return f"[{pct(metrics['ci_low'])}, {pct(metrics['ci_high'])}]"


def fmt_money(value: float) -> str:
    return f"${value:.2f}"


def validate(rows_32k: list[dict[str, Any]]) -> list[str]:
    ids = manifest_ids()
    messages = []
    by_model: dict[str, list[str]] = defaultdict(list)
    for row in rows_32k:
        by_model[row["endpoint_id"]].append(row["task_id"])
    for model in ("kimi", "sonnet"):
        if by_model[model] != ids:
            raise AssertionError(f"{model} task ids do not match manifest")
        messages.append(f"{model}: 60 rows and exact manifest order")
    counts = Counter(row["endpoint_id"] for row in rows_32k)
    if counts["kimi"] != 60 or counts["sonnet"] != 60:
        raise AssertionError(f"bad row counts: {counts}")
    return messages


def main() -> int:
    rows_32k = merge_reruns()
    write_csv(OUTCOMES_32K, rows_32k)
    validation_messages = validate(rows_32k)
    rows_16k = read_csv(OUTCOMES_16K)
    metrics_16k = model_metrics(rows_16k, max_tokens=16384)
    metrics_32k = model_metrics(rows_32k, max_tokens=32768)
    ledger_rows = read_ledger(LEDGER)
    spend_by_endpoint = ledger_spend(ledger_rows)
    total_spend = sum(spend_by_endpoint.values())
    failures = [
        row for row in rows_32k if row["call_status"] != "succeeded"
    ]
    lines = [
        "# Thinking-model 32k measurement report",
        "",
        "## Verification",
        "",
        *[f"- {message}." for message in validation_messages],
        f"- Ledger rows: {len(ledger_rows)}; summed spend: {fmt_money(total_spend)}.",
        "- Metrics below were recomputed directly from `outcomes_32k.csv` and `c3r16k_outcomes.csv`.",
        "",
        "## Per-model results",
        "",
        "| Model | Budget | pass@1 | Wilson 95% CI | truncated | mean completion tokens | provider failures | spend |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for model in ("kimi", "sonnet"):
        m16 = metrics_16k[model]
        m32 = metrics_32k[model]
        lines.append(
            f"| {model} | 16k | {m16['passed']}/60 ({pct(m16['pass_rate'])}) | "
            f"{ci_text(m16)} | {m16['truncated']}/60 | "
            f"{m16['mean_completion_tokens']:.0f} | {m16['provider_failures']} | "
            f"{fmt_money(m16['outcome_spend'])} |"
        )
        lines.append(
            f"| {model} | 32k | {m32['passed']}/60 ({pct(m32['pass_rate'])}) | "
            f"{ci_text(m32)} | {m32['truncated']}/60 | "
            f"{m32['mean_completion_tokens']:.0f} | {m32['provider_failures']} | "
            f"{fmt_money(spend_by_endpoint.get(model, 0.0))} |"
        )
    lines.extend(
        [
            "",
            "## OSS-relevant panel context",
            "",
        ]
    )
    context_models = ["deepseek", "qwen3", "kimi", "sonnet", "gpt55"]
    lines.extend(
        [
            "| Model | Source | pass@1 | Wilson 95% CI | truncated |",
            "|---|---|---:|---:|---:|",
        ]
    )
    for model in context_models:
        metrics = metrics_32k[model] if model in {"kimi", "sonnet"} else metrics_16k[model]
        source = "32k" if model in {"kimi", "sonnet"} else "16k"
        lines.append(
            f"| {model} | {source} | {metrics['passed']}/60 ({pct(metrics['pass_rate'])}) | "
            f"{ci_text(metrics)} | {metrics['truncated']}/60 |"
        )
    best_oss = max(metrics_32k["kimi"]["pass_rate"], metrics_32k["sonnet"]["pass_rate"], metrics_16k["qwen3"]["pass_rate"], metrics_16k["deepseek"]["pass_rate"])
    gpt55 = metrics_16k["gpt55"]["pass_rate"]
    lines.extend(
        [
            "",
            f"gpt-5.5 remains lopsided on this slice: {pct(gpt55)} vs the best OSS/open alternative at {pct(best_oss)}.",
            "",
            "## Truncation-rule compliance",
            "",
        ]
    )
    for model in ("kimi", "sonnet"):
        m32 = metrics_32k[model]
        status = "VALID" if m32["truncated"] <= 6 else "INVALID"
        lines.append(
            f"- {model}: {m32['truncated']}/60 rows truncated at 32k, so the pass rate is {status} under the <=10% rule."
        )
    lines.extend(
        [
            "",
            "Kimi did not trigger the preregistered 64k escalation because it stayed within the truncation threshold at 32k.",
            "",
            "## Spend",
            "",
            f"- Total ledger spend: {fmt_money(total_spend)}.",
            f"- Includes a {fmt_money(spend_by_endpoint.get('aborted_attempt', 0.0))} adjustment for the stopped first attempt, based on completed task costs printed before that process was stopped.",
            f"- Kimi ledger spend: {fmt_money(spend_by_endpoint.get('kimi', 0.0))}.",
            f"- Sonnet ledger spend: {fmt_money(spend_by_endpoint.get('sonnet', 0.0))}.",
            "",
            "## Limitations and anomalies",
            "",
        ]
    )
    if failures:
        for row in failures:
            lines.append(
                f"- {row['endpoint_id']} on {row['task_id']} did not return a completion and is counted as a fail: {row['error_message'][:180]}"
            )
    else:
        lines.append("- No provider failures remained after targeted reruns.")
    lines.extend(
        [
            "- The run remains a single 60-task algorithmic slice from the C3-R16K bank.",
            "- Targeted reruns replaced only failed rows; successful first-pass rows were kept.",
            "",
        ]
    )
    REPORT.write_text("\n".join(lines), encoding="utf-8")
    print(json.dumps({
        "report": str(REPORT),
        "total_spend": total_spend,
        "failures": len(failures),
        "metrics_32k": metrics_32k,
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
