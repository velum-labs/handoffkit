"""Analyzer for the D10 seed-panel truncation audit.

Recomputes pass rates, truncation counts, and spend directly from the outcome
CSVs and the ledger, merges targeted rerun files if present, and writes the
round report with a binding per-model verdict.
"""

from __future__ import annotations

import csv
import json
from collections import defaultdict
from pathlib import Path
from typing import Any

from hyperkit.stats import wilson_interval

ROOT = Path(__file__).resolve().parents[3]
ROUND = ROOT / "analysis" / "seed-audit-32k"
PHASE0 = ROOT / "analysis" / "phase0"
OUTCOMES_32K = ROUND / "outcomes_32k.csv"
OUTCOMES_64K = ROUND / "outcomes_64k_escalated.csv"
RERUN_32K = sorted((ROUND / "cache").glob("outcomes_32k_rerun*.csv"))
RERUN_64K = sorted((ROUND / "cache").glob("outcomes_64k_rerun*.csv"))
LEDGER = ROUND / "spend_ledger.jsonl"
REPORT = ROUND / "report.md"
MANIFEST = PHASE0 / "c3_task_manifest.json"
MODELS = ("r1", "terminus", "qwen3t")
MODEL_LABELS = {
    "r1": "deepseek-r1-0528",
    "terminus": "deepseek-v3.1-terminus",
    "qwen3t": "qwen3-235b-a22b-thinking-2507",
}

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


def numeric(row: dict[str, Any], key: str) -> float | None:
    value = row.get(key)
    if value in (None, ""):
        return None
    return float(value)


def merge_reruns(outcomes_path: Path, rerun_paths: list[Path]) -> list[dict[str, Any]]:
    rows = read_csv(outcomes_path)
    failed_keys = {
        (row["task_id"], row["endpoint_id"])
        for row in rows
        if row["call_status"] != "succeeded"
    }
    replacements: dict[tuple[str, str], dict[str, str]] = {}
    for path in rerun_paths:
        for row in read_csv(path):
            key = (row["task_id"], row["endpoint_id"])
            if key in failed_keys:
                prior = replacements.get(key)
                if prior is None or (
                    prior["call_status"] != "succeeded" and row["call_status"] == "succeeded"
                ):
                    replacements[key] = row
    return [replacements.get((row["task_id"], row["endpoint_id"]), row) for row in rows]


def model_metrics(rows: list[dict[str, Any]], max_tokens: int) -> dict[str, dict[str, Any]]:
    by_model: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_model[row["endpoint_id"]].append(row)
    out = {}
    for model, model_rows in sorted(by_model.items()):
        succeeded = [row for row in model_rows if row["call_status"] == "succeeded"]
        n = len(model_rows)
        passed = sum(int(row["passed"]) for row in model_rows)
        trunc = sum(
            1
            for row in succeeded
            if (tokens := numeric(row, "completion_tokens")) is not None and tokens >= max_tokens
        )
        completion_tokens = [numeric(row, "completion_tokens") or 0.0 for row in model_rows]
        cost = sum(numeric(row, "charged_cost_usd") or 0.0 for row in model_rows)
        ci = wilson_interval(passed, n, z=1.959963984540054)
        estimate, low, high = ci.estimate, ci.low, ci.high
        out[model] = {
            "n": n,
            "n_succeeded": len(succeeded),
            "passed": passed,
            "pass_rate": estimate,
            "ci_low": low,
            "ci_high": high,
            "truncated": trunc,
            "mean_completion_tokens": (sum(completion_tokens) / n) if n else 0.0,
            "outcome_spend": cost,
            "provider_failures": n - len(succeeded),
        }
    return out


def manifest_ids() -> list[str]:
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    return [str(row["task_id"]) for row in data["tasks"]]


def ledger_spend() -> tuple[float, dict[str, float]]:
    spend: dict[str, float] = defaultdict(float)
    total = 0.0
    for line in LEDGER.read_text(encoding="utf-8").splitlines():
        if not line:
            continue
        row = json.loads(line)
        value = row.get("charged_cost_usd")
        if isinstance(value, int | float):
            total += float(value)
            spend[str(row.get("endpoint_id") or "unknown")] += float(value)
    return total, dict(spend)


def pct(value: float) -> str:
    return f"{value * 100:.1f}%"


def verdict_for(model: str, m32: dict[str, Any], m64: dict[str, Any] | None) -> tuple[str, str]:
    if m32["truncated"] <= 6:
        return "VALID at 32k", (
            f"{MODEL_LABELS[model]} is validly measurable at a 32k completion budget "
            f"({m32['truncated']}/{m32['n_succeeded']} truncated)."
        )
    if m64 is not None and m64["truncated"] <= 6:
        return "VALID at 64k", (
            f"{MODEL_LABELS[model]} exceeds the truncation threshold at 32k "
            f"({m32['truncated']}/{m32['n_succeeded']}) but is valid at 64k "
            f"({m64['truncated']}/{m64['n_succeeded']} truncated); capture pilots that "
            "include it must budget 64k completions."
        )
    if m64 is not None:
        return "NOT MEASURABLE", (
            f"{MODEL_LABELS[model]} stays above the truncation threshold at both 32k "
            f"({m32['truncated']}/{m32['n_succeeded']}) and 64k "
            f"({m64['truncated']}/{m64['n_succeeded']}); it is not measurable at practical "
            "budgets on this slice and must be excluded or renegotiated before any "
            "capture pilot."
        )
    return "ESCALATION PENDING", (
        f"{MODEL_LABELS[model]} exceeds the truncation threshold at 32k "
        f"({m32['truncated']}/{m32['n_succeeded']}); the preregistered 64k escalation has "
        "not produced outcomes yet."
    )


def main() -> int:
    rows_32k = merge_reruns(OUTCOMES_32K, RERUN_32K)
    write_csv(OUTCOMES_32K, rows_32k)
    ids = manifest_ids()
    validation = []
    by_model: dict[str, list[str]] = defaultdict(list)
    for row in rows_32k:
        by_model[row["endpoint_id"]].append(row["task_id"])
    for model in MODELS:
        if by_model[model] != ids:
            raise AssertionError(f"{model} task ids do not match manifest")
        validation.append(f"{model}: 60 rows and exact manifest order")
    metrics_32k = model_metrics(rows_32k, max_tokens=32768)
    metrics_64k: dict[str, dict[str, Any]] = {}
    if OUTCOMES_64K.exists():
        rows_64k = merge_reruns(OUTCOMES_64K, RERUN_64K)
        write_csv(OUTCOMES_64K, rows_64k)
        metrics_64k = model_metrics(rows_64k, max_tokens=65536)
        for model in metrics_64k:
            escalated_ids = [r["task_id"] for r in rows_64k if r["endpoint_id"] == model]
            if escalated_ids != ids:
                raise AssertionError(f"64k {model} task ids do not match manifest")
            validation.append(f"{model} 64k escalation: 60 rows and exact manifest order")
    total_spend, spend_by_endpoint = ledger_spend()
    lines = [
        "# D10 seed-panel truncation audit report",
        "",
        "## Verification",
        "",
        *[f"- {message}." for message in validation],
        f"- Ledger summed spend: ${total_spend:.2f} (cap $20.00).",
        "- Metrics recomputed directly from the outcome CSVs, not script stdout.",
        "",
        "## Per-model results",
        "",
        "| Model | Budget | pass@1 (context) | Wilson 95% CI | truncated | mean completion tokens | provider failures | spend |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for model in MODELS:
        m32 = metrics_32k[model]
        lines.append(
            f"| {MODEL_LABELS[model]} | 32k | {m32['passed']}/{m32['n']} ({pct(m32['pass_rate'])}) | "
            f"[{pct(m32['ci_low'])}, {pct(m32['ci_high'])}] | {m32['truncated']}/{m32['n_succeeded']} | "
            f"{m32['mean_completion_tokens']:.0f} | {m32['provider_failures']} | "
            f"${m32['outcome_spend']:.2f} |"
        )
        if model in metrics_64k:
            m64 = metrics_64k[model]
            lines.append(
                f"| {MODEL_LABELS[model]} | 64k | {m64['passed']}/{m64['n']} ({pct(m64['pass_rate'])}) | "
                f"[{pct(m64['ci_low'])}, {pct(m64['ci_high'])}] | {m64['truncated']}/{m64['n_succeeded']} | "
                f"{m64['mean_completion_tokens']:.0f} | {m64['provider_failures']} | "
                f"${m64['outcome_spend']:.2f} |"
            )
    lines.extend(["", "## Verdicts (binding for the D10 seed panel)", ""])
    for model in MODELS:
        verdict, explanation = verdict_for(model, metrics_32k[model], metrics_64k.get(model))
        lines.append(f"- **{MODEL_LABELS[model]}: {verdict}.** {explanation}")
    lines.extend(
        [
            "",
            "## Spend",
            "",
            f"- Total ledger spend: ${total_spend:.2f}.",
            *[
                f"- {endpoint}: ${amount:.2f}"
                for endpoint, amount in sorted(spend_by_endpoint.items())
            ],
            "",
            "## Limitations",
            "",
            "- Algorithmic 60-task slice; truncation behavior on repo-bugfix prompts may "
            "differ (longer prompts, but patch outputs are usually shorter than full "
            "programs). Revisit after Step 4 unlocks repo grading.",
            "- Pass rates are context only; this round measures validity, not domain skill.",
            "",
        ]
    )
    REPORT.write_text("\n".join(lines), encoding="utf-8")
    print(
        json.dumps(
            {
                "report": str(REPORT),
                "total_spend": round(total_spend, 4),
                "metrics_32k": {
                    model: {
                        "passed": metric["passed"],
                        "truncated": metric["truncated"],
                        "failures": metric["provider_failures"],
                    }
                    for model, metric in metrics_32k.items()
                },
                "metrics_64k": {
                    model: {
                        "passed": metric["passed"],
                        "truncated": metric["truncated"],
                        "failures": metric["provider_failures"],
                    }
                    for model, metric in metrics_64k.items()
                },
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
