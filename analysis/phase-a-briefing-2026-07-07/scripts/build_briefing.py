"""Build the Phase A visual briefing from the committed catalog snapshot and hypothesis cards.

Reads docs/fusion/catalog-snapshot-2026-07-07.yaml and labruns/2026-q3/hypotheses/*.md,
and writes a self-contained phase_a_briefing.html next to this script's parent directory.
Regenerate with:

    uv run python analysis/phase-a-briefing-2026-07-07/scripts/build_briefing.py
"""

from __future__ import annotations

import html
import math
import re
from pathlib import Path
from typing import Any

import yaml

REPO = Path(__file__).resolve().parents[3]
SNAPSHOT = REPO / "docs/fusion/catalog-snapshot-2026-07-07.yaml"
CARDS_DIR = REPO / "labruns/2026-q3/hypotheses"
OUT = Path(__file__).resolve().parents[1] / "phase_a_briefing.html"

BENCHMARKS = [
    ("livecodebench", "LiveCodeBench"),
    ("swe-bench-pro", "SWE-bench Pro"),
    ("aider-polyglot", "Aider polyglot"),
    ("artificial_analysis_coding_index", "AA coding index"),
]

BENCHMARK_META: dict[str, dict[str, str]] = {
    "livecodebench": {
        "what": "Rolling algorithmic coding benchmark (standalone functions, pass@1).",
        "url": "https://llm-stats.com/benchmarks/livecodebench",
        "official": "https://livecodebench.github.io/",
        "saturated": "no",
    },
    "swe-bench-pro": {
        "what": "Repository bugfix benchmark (harder than deprecated SWE-bench Verified).",
        "url": "https://benchlm.ai/benchmarks/swePro",
        "official": "https://www.swebench.com/",
        "saturated": "no",
    },
    "aider-polyglot": {
        "what": "Multi-language edit competence (polyglot leaderboard).",
        "url": "https://aider.chat/docs/leaderboards/",
        "official": "https://aider.chat/docs/leaderboards/",
        "saturated": "no",
    },
    "artificial_analysis_coding_index": {
        "what": "Composite coding index (Terminal-Bench v2.1 + SciCode, among others).",
        "url": "https://artificialanalysis.ai/models/capabilities/coding",
        "official": "https://artificialanalysis.ai/",
        "saturated": "no",
    },
}

HYPOTHESIS_BLURBS: dict[str, str] = {
    "h1-backbone": (
        "The honest default: take the three highest-ranked shortlist models that do not share a "
        "lineage family. Every other hypothesis must beat this on our own harness in Phase C."
    ),
    "h2-style-diverse": (
        "Same as H1 but swaps one near-tie model (within ~3 pp on the public mean) for a "
        "different style — here GLM-5.2 replaces DeepSeek V4 Pro to spread reasoning vs "
        "code-specialist vs generalist families."
    ),
    "h3-cheap-cascade": (
        "Answer with the cheapest competent model first; only call the full H1 panel + judge if "
        "the cheap answer fails grading. Tests whether fusion complexity pays on $/solve. "
        "Marked deferred because the cascade wrapper is not built yet."
    ),
    "h4-self-moa": (
        "Mandatory honesty baseline: sample the strongest single shortlist member (DeepSeek V3.2) "
        "three times and keep the best answer via execution-guided selection — no judge. If this "
        "beats every panel, the shippable product is routing, not fusion."
    ),
    "h5-thinking-heavy": (
        "Two reasoning-class models plus one fast generalist, all at 64k completion budgets. "
        "Tests whether paying for long thinking outputs buys measurable headroom at current prices."
    ),
}

FAMILY_COLORS = {
    "deepseek-v3": "#2563eb",
    "deepseek-v4": "#0ea5e9",
    "glm-5": "#16a34a",
    "glm-4.7": "#4ade80",
    "kimi-k2": "#d97706",
    "qwen3": "#7c3aed",
    "qwen3.7": "#a855f7",
    "qwen3-max": "#c084fc",
    "qwen3-coder": "#8b5cf6",
    "nemotron-3-super": "#dc2626",
    "nemotron-3-ultra": "#f87171",
    "minimax-m3": "#0d9488",
    "minimax-m2": "#2dd4bf",
    "mimo-v2.5": "#db2777",
}
DEFAULT_FAMILY_COLOR = "#64748b"

# Cost model shared with the hypothesis cards: default request = 2k input + 8k output.
REQ_IN_TOK, REQ_OUT_TOK = 2_000, 8_000
ANCHOR_IN_PER_M, ANCHOR_OUT_PER_M = 5.0, 30.0
ANCHOR_PRICE_URL = "https://aicost.tools/llm-cost/openai/gpt-5-5/"


def norm_score(value: float) -> float:
    """Leaderboards mix 0-1 fractions and 0-100 percentages; normalize to 0-100."""
    return value * 100 if value <= 1 else value


def esc(text: Any) -> str:
    return html.escape(str(text))


def link(url: str, label: str) -> str:
    return f'<a href="{esc(url)}" target="_blank" rel="noopener">{esc(label)}</a>'


def family_color(family: str) -> str:
    return FAMILY_COLORS.get(family, DEFAULT_FAMILY_COLOR)


def blended_request_cost(pricing: dict[str, float]) -> float:
    return (REQ_IN_TOK * pricing["input_per_m"] + REQ_OUT_TOK * pricing["output_per_m"]) / 1e6


def anchor_request_cost() -> float:
    return (REQ_IN_TOK * ANCHOR_IN_PER_M + REQ_OUT_TOK * ANCHOR_OUT_PER_M) / 1e6


def load_cards() -> list[dict[str, Any]]:
    cards = []
    for path in sorted(CARDS_DIR.glob("*.md")):
        text = path.read_text(encoding="utf-8")
        match = re.match(r"---\n(.*?)\n---", text, re.S)
        if not match:
            continue
        front = yaml.safe_load(match.group(1))
        front["_prose"] = text[match.end():].strip()
        cards.append(front)
    return cards


def collect_source_urls(candidates: list[dict[str, Any]], snap: dict[str, Any]) -> list[tuple[str, str, str]]:
    """Return (category, label, url) tuples for the sources appendix."""
    rows: list[tuple[str, str, str]] = [
        ("Catalog", "OpenRouter models API (live pull)", snap.get("source_url", "")),
        ("Catalog", "Catalog snapshot YAML (committed)", "docs/fusion/catalog-snapshot-2026-07-07.yaml"),
        ("Catalog", "Catalog snapshot prose + judgment calls", "docs/fusion/catalog-snapshot-2026-07-07.md"),
        ("Plan", "Clean-room ensemble launch plan (Phases A–D)", "docs/fusion/ensemble-launch-clean-room-2026-07.md"),
        ("Pricing anchor", "GPT-5.5-class API pricing (frontier closed model)", ANCHOR_PRICE_URL),
    ]
    for key, meta in BENCHMARK_META.items():
        rows.append(("Benchmark", f"{key} — page used for scores", meta["url"]))
        if meta.get("official") and meta["official"] != meta["url"]:
            rows.append(("Benchmark", f"{key} — official / primary site", meta["official"]))
    seen: set[str] = set()
    for cand in candidates:
        for entry in cand.get("coding_evidence") or []:
            url = entry.get("url", "")
            if url and url not in seen:
                seen.add(url)
                rows.append(("Per-model evidence", entry.get("harness", url)[:80], url))
    return rows


def scatter_svg(candidates: list[dict[str, Any]], panel_slugs: set[str], judge_slug: str) -> str:
    """Price-vs-score scatter: x = log blended request cost, y = aggregate mean."""
    points = [c for c in candidates if c.get("aggregate_mean") is not None]
    width, height, pad_l, pad_r, pad_t, pad_b = 940, 430, 64, 20, 18, 56
    costs = [blended_request_cost(c["pricing"]) for c in points]
    xmin, xmax = math.log10(min(costs) * 0.8), math.log10(max(costs) * 1.3)
    ymin = min(c["aggregate_mean"] for c in points) - 4
    ymax = max(c["aggregate_mean"] for c in points) + 4

    def sx(cost: float) -> float:
        return pad_l + (math.log10(cost) - xmin) / (xmax - xmin) * (width - pad_l - pad_r)

    def sy(score: float) -> float:
        return height - pad_b - (score - ymin) / (ymax - ymin) * (height - pad_t - pad_b)

    parts = [
        f'<svg viewBox="0 0 {width} {height}" role="img" '
        f'aria-label="Scatter chart of model cost versus public aggregate score" '
        f'style="width:100%;height:auto;background:#fff;border-radius:8px">'
    ]
    for tick in [0.001, 0.003, 0.01, 0.03]:
        if xmin <= math.log10(tick) <= xmax:
            x = sx(tick)
            parts.append(f'<line x1="{x:.1f}" y1="{pad_t}" x2="{x:.1f}" y2="{height - pad_b}" stroke="#eef1f6"/>')
            parts.append(
                f'<text x="{x:.1f}" y="{height - pad_b + 18}" text-anchor="middle" font-size="12" fill="#5b6579">'
                f"${tick:g}</text>"
            )
    for tick in range(int(ymin // 10 + 1) * 10, int(ymax) + 1, 10):
        y = sy(tick)
        parts.append(f'<line x1="{pad_l}" y1="{y:.1f}" x2="{width - pad_r}" y2="{y:.1f}" stroke="#eef1f6"/>')
        parts.append(
            f'<text x="{pad_l - 8}" y="{y + 4:.1f}" text-anchor="end" font-size="12" fill="#5b6579">{tick}</text>'
        )
    parts.append(
        f'<text x="{(pad_l + width - pad_r) / 2:.0f}" y="{height - 10}" text-anchor="middle" font-size="12.5" '
        f'fill="#5b6579">blended cost per default request (2k in + 8k out, log scale)</text>'
    )
    parts.append(
        f'<text x="16" y="{(pad_t + height - pad_b) / 2:.0f}" text-anchor="middle" font-size="12.5" fill="#5b6579" '
        f'transform="rotate(-90 16 {(pad_t + height - pad_b) / 2:.0f})">aggregate mean (0-100)</text>'
    )

    labeled = {c["slug"] for c in sorted(points, key=lambda c: -c["aggregate_mean"])[:12]}
    for cand in sorted(points, key=lambda c: c["aggregate_mean"]):
        slug = cand["slug"]
        x, y = sx(blended_request_cost(cand["pricing"])), sy(cand["aggregate_mean"])
        color = family_color(cand["lineage"]["base_family"])
        in_panel, is_judge = slug in panel_slugs, slug == judge_slug
        radius = 8 if in_panel or is_judge else 5.5
        stroke = '#0f172a" stroke-width="2.5' if in_panel else ('#d97706" stroke-width="2.5' if is_judge else "#fff")
        parts.append(
            f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{radius}" fill="{color}" stroke="{stroke}">'
            f"<title>{esc(slug)} - mean {cand['aggregate_mean']:.1f}, "
            f"${blended_request_cost(cand['pricing']):.4f}/req</title></circle>"
        )
        if slug in labeled:
            name = slug.split("/", 1)[1]
            anchor, dx = ("start", 11) if x < width - 200 else ("end", -11)
            parts.append(
                f'<text x="{x + dx:.1f}" y="{y + 4:.1f}" text-anchor="{anchor}" font-size="11.5" '
                f'fill="#1a2233">{esc(name)}</text>'
            )
    parts.append("</svg>")
    return "".join(parts)


def coverage_matrix(candidates: list[dict[str, Any]]) -> str:
    rows = []
    ordered = sorted(candidates, key=lambda c: (-(c.get("aggregate_mean") or -1), c["slug"]))
    for cand in ordered:
        by_bench: dict[str, dict[str, Any]] = {}
        for entry in cand.get("coding_evidence") or []:
            by_bench.setdefault(entry["benchmark"], entry)
        cells = []
        for key, _label in BENCHMARKS:
            entry = by_bench.get(key)
            if entry is None:
                cells.append('<td class="cov none">-</td>')
                continue
            score = norm_score(float(entry["score"]))
            if entry.get("saturated"):
                cls, note = "sat", "saturated — excluded from ranking mean"
            elif entry.get("trust") == "vendor-claimed":
                cls, note = "vendor", "vendor-claimed — excluded from ranking mean"
            else:
                cls, note = "tp", "third-party — included in ranking mean"
            url = entry.get("url", "")
            score_html = (
                link(url, f"{score:.1f}") if url else f"{score:.1f}"
            )
            title = esc(f"{note}. {entry.get('harness', '')} (as_of: {entry.get('as_of', '?')})")
            cells.append(f'<td class="cov {cls}" title="{title}">{score_html}</td>')
        mean = cand.get("aggregate_mean")
        mean_txt = f"{mean:.1f}" if mean is not None else '<span class="mut">-</span>'
        flags = " ".join(f'<span class="tag warn">{esc(f)}</span>' for f in cand.get("flags") or [])
        rows.append(
            f'<tr><td><code>{esc(cand["slug"])}</code> {flags}</td>'
            f'<td><span class="fam" style="background:{family_color(cand["lineage"]["base_family"])}"></span>'
            f'{esc(cand["lineage"]["base_family"])}</td>{"".join(cells)}<td class="num">{mean_txt}</td></tr>'
        )
    heads = "".join(f"<th>{label}</th>" for _key, label in BENCHMARKS)
    return (
        f'<table><thead><tr><th>Model</th><th>Family</th>{heads}<th>Mean</th></tr></thead>'
        f'<tbody>{"".join(rows)}</tbody></table>'
    )


def benchmark_explainer() -> str:
    items = []
    for key, label in BENCHMARKS:
        meta = BENCHMARK_META[key]
        items.append(
            f"<li><b>{esc(label)}</b> — {esc(meta['what'])} "
            f"Scores retrieved from {link(meta['url'], 'leaderboard page')}"
            f" (saturated for ranking: <b>{meta['saturated']}</b>)."
            f"</li>"
        )
    return f"<ul class='tight'>{''.join(items)}</ul>"


def hypothesis_section(cards: list[dict[str, Any]], slug_meta: dict[str, dict[str, Any]]) -> str:
    max_sweep = max(float(c["cost_projection"]["sweep_60_tasks_usd"]) for c in cards)
    blocks = []
    for card in cards:
        hid = card["hypothesis_id"]
        status = card["status"]
        status_cls = {"ready": "pass", "deferred": "warn"}.get(status, "info")
        blurb = HYPOTHESIS_BLURBS.get(hid, "")
        member_chips = []
        for member in card.get("panel") or []:
            slug = member["slug"]
            family = slug_meta.get(slug, {}).get("family", "?")
            budget_k = member["max_completion_tokens"] // 1024
            member_chips.append(
                f'<span class="mchip" style="border-color:{family_color(family)}">'
                f'<span class="fam" style="background:{family_color(family)}"></span>'
                f"{esc(slug.split('/', 1)[1])} <small>{budget_k}k cap</small></span>"
            )
        judge = card.get("judge") or {}
        if judge.get("slug"):
            judge_txt = (
                f'Judge (synthesizer): <b>{esc(judge["slug"])}</b> — reads all panel answers and '
                f'merges them into one final response. Pinned as <code>{esc(judge.get("endpoint_id", ""))}</code>.'
            )
        else:
            judge_txt = (
                "<b>No judge.</b> H4 uses execution-guided best-of-N: each sample is graded against "
                "public tests; the best passing sample wins. No synthesizer call."
            )
        k_samples = (card.get("sampling") or {}).get("k_samples", 1)
        per_req = float(card["cost_projection"]["per_request_usd"])
        sweep = float(card["cost_projection"]["sweep_60_tasks_usd"])
        bar_pct = max(sweep / max_sweep * 100, 4)
        prov = card.get("provenance") or {}
        blocks.append(f"""
<div class="card hyp" id="{esc(hid)}">
  <div class="hyphead">
    <h3>{esc(hid)}</h3>
    <span class="tag {status_cls}">{esc(status)}</span>
    <span class="tag info">{esc(card["topology"])}</span>
    <span class="tag dir">K={k_samples}</span>
  </div>
  <p class="prose">{esc(blurb)}</p>
  <div class="mchips">{"".join(member_chips)}</div>
  <p class="sub" style="margin:10px 0 8px">{judge_txt}</p>
  <div class="barrow"><div class="lab">60-task sweep</div>
    <div class="track"><div class="fill blue" style="width:{bar_pct:.0f}%">${sweep:.2f}</div></div>
    <div class="val">${per_req:.4f}/request</div></div>
  <table class="pk"><tbody>
    <tr><td class="pklab">predicts</td><td>{esc(card["prediction"])}</td></tr>
    <tr><td class="pklab">killed if</td><td>{esc(card["kill_condition"])}</td></tr>
    <tr><td class="pklab">card file</td><td><code>labruns/2026-q3/hypotheses/{esc(hid)}.md</code></td></tr>
    <tr><td class="pklab">rules</td><td><code>{esc(prov.get("rules_version", ""))}</code></td></tr>
  </tbody></table>
</div>""")
    return "".join(blocks)


def sources_table(rows: list[tuple[str, str, str]]) -> str:
    body = []
    for category, label, url in rows:
        href = link(url, url) if url.startswith("http") else f"<code>{esc(url)}</code>"
        body.append(f"<tr><td>{esc(category)}</td><td>{esc(label)}</td><td>{href}</td></tr>")
    return (
        "<table><thead><tr><th>Category</th><th>What it is</th><th>URL / path</th></tr></thead>"
        f"<tbody>{''.join(body)}</tbody></table>"
    )


def build() -> None:
    snap = yaml.safe_load(SNAPSHOT.read_text(encoding="utf-8"))
    candidates = snap["candidates"]
    cards = load_cards()
    slug_meta = {c["slug"]: {"family": c["lineage"]["base_family"]} for c in candidates}
    source_rows = collect_source_urls(candidates, snap)

    panel_slugs = {m["slug"] for card in cards for m in card.get("panel") or []}
    judge_slug = next(
        (card["judge"]["slug"] for card in cards if (card.get("judge") or {}).get("slug")), ""
    )
    ranked = sorted(
        (c for c in candidates if c.get("aggregate_mean") is not None),
        key=lambda c: -c["aggregate_mean"],
    )
    shortlist = ranked[:12]
    anchor_cost = anchor_request_cost()
    envelope = anchor_cost / 3

    ledger_rows = []
    for f in snap["filter_ledger"]:
        rule = f.get("rule", "")
        ledger_rows.append(
            f'<tr><td><b>{esc(f["filter"])}</b><br><span class="mut" style="font-size:12px">'
            f'{esc(rule)}</span></td>'
            f'<td class="num">-{f["rows_removed"]}</td>'
            f'<td class="num">{f["rows_after"]}</td></tr>'
        )

    shortlist_rows = []
    for rank, cand in enumerate(shortlist, start=1):
        benches = sorted(
            {
                e["benchmark"]
                for e in cand["coding_evidence"]
                if e.get("trust") == "third-party" and not e.get("saturated")
            }
        )
        bench_count = len(benches)
        count_cls = "pass" if bench_count >= 2 else "warn"
        in_use = cand["slug"] in panel_slugs or cand["slug"] == judge_slug
        role = ""
        if cand["slug"] in panel_slugs:
            role = '<span class="tag pass">panel</span>'
        elif cand["slug"] == judge_slug:
            role = '<span class="tag warn">judge</span>'
        bench_names = ", ".join(benches) if benches else "none"
        shortlist_rows.append(
            f'<tr{" class=inuse" if in_use else ""}><td class="num">{rank}</td>'
            f'<td><code>{esc(cand["slug"])}</code> {role}</td>'
            f'<td class="num">{cand["aggregate_mean"]:.1f}</td>'
            f'<td><span class="tag {count_cls}">{bench_count} bench{"es" if bench_count != 1 else ""}</span>'
            f'<br><span class="mut" style="font-size:11.5px">{esc(bench_names)}</span></td>'
            f'<td>{esc(cand["lineage"]["base_family"])}</td>'
            f'<td class="num">${blended_request_cost(cand["pricing"]):.4f}</td></tr>'
        )

    tp_count = sum(
        1
        for c in candidates
        if any(e.get("trust") == "third-party" for e in c.get("coding_evidence") or [])
    )
    none_count = sum(1 for c in candidates if not (c.get("coding_evidence") or []))
    none_models = [c["slug"] for c in candidates if not (c.get("coding_evidence") or [])]

    page = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FusionKit Phase A Briefing - Clean-Room Catalog, Shortlist, Hypotheses (2026-07-07)</title>
<style>
  :root{{--ink:#1a2233;--muted:#5b6579;--line:#e3e7ef;--bg:#f7f8fb;--card:#fff;
    --blue:#2563eb;--blue-soft:#dbeafe;--green:#16a34a;--green-soft:#dcfce7;
    --red:#dc2626;--red-soft:#fee2e2;--amber:#d97706;--amber-soft:#fef3c7;
    --violet:#7c3aed;--violet-soft:#ede9fe}}
  *{{box-sizing:border-box}}
  body{{margin:0;font:15px/1.55 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:var(--bg)}}
  .wrap{{max-width:1080px;margin:0 auto;padding:32px 28px 80px}}
  header.hero{{background:linear-gradient(135deg,#0f172a 0%,#1e3a8a 100%);color:#fff;border-radius:14px;padding:30px 34px;margin-bottom:26px}}
  header.hero h1{{margin:0 0 6px;font-size:25px}}
  header.hero p{{margin:0;color:#c7d2fe;font-size:15px}}
  .chips{{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}}
  .chip{{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.25);border-radius:999px;padding:5px 14px;font-size:13px;color:#e0e7ff}}
  .chip b{{color:#fff}}
  h2{{font-size:20px;margin:38px 0 6px;display:flex;align-items:center;gap:10px}}
  h2 .num{{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:8px;background:var(--blue);color:#fff;font-size:14px;flex:none}}
  h3{{font-size:16px;margin:0 0 8px}}
  .sub{{color:var(--muted);margin:0 0 14px;font-size:14px;line-height:1.6}}
  .prose{{margin:0 0 12px;font-size:14.5px;line-height:1.6}}
  .card{{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px 22px;margin-bottom:14px}}
  .callout{{border-left:4px solid var(--blue);background:var(--blue-soft);padding:14px 18px;border-radius:0 10px 10px 0;margin:0 0 14px;font-size:14px;line-height:1.6}}
  .callout.warn{{border-color:var(--amber);background:var(--amber-soft)}}
  .callout b{{color:var(--ink)}}
  .tag{{display:inline-block;border-radius:6px;padding:2px 9px;font-size:12px;font-weight:600}}
  .tag.pass{{background:var(--green-soft);color:var(--green)}}
  .tag.fail{{background:var(--red-soft);color:var(--red)}}
  .tag.warn{{background:var(--amber-soft);color:var(--amber)}}
  .tag.info{{background:var(--blue-soft);color:var(--blue)}}
  .tag.dir{{background:var(--violet-soft);color:var(--violet)}}
  table{{width:100%;border-collapse:collapse;font-size:13.5px}}
  th{{text-align:left;color:var(--muted);font-weight:600;padding:7px 10px;border-bottom:2px solid var(--line);vertical-align:bottom}}
  td{{padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}}
  tr:last-child td{{border-bottom:none}}
  td.num,th.num{{text-align:right;font-variant-numeric:tabular-nums}}
  tr.inuse{{background:#f0f6ff}}
  code{{font-size:12.5px;background:#eef1f6;border-radius:4px;padding:1px 5px}}
  a{{color:var(--blue);text-decoration:none}}
  a:hover{{text-decoration:underline}}
  .mut{{color:var(--muted)}}
  .cov{{text-align:right;font-variant-numeric:tabular-nums;font-size:12.5px}}
  .cov a{{color:inherit;font-weight:600}}
  .cov.tp{{background:var(--green-soft);color:#14532d}}
  .cov.vendor{{background:var(--amber-soft);color:#7c2d12}}
  .cov.sat{{background:var(--violet-soft);color:#4c1d95}}
  .cov.none{{color:#cbd5e1;text-align:center}}
  .fam{{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px}}
  .legend{{display:flex;gap:14px;flex-wrap:wrap;font-size:12.5px;color:var(--muted);margin:10px 0 0}}
  .legend .cov{{padding:1px 8px;border-radius:5px}}
  .barrow{{display:grid;grid-template-columns:120px 1fr 150px;align-items:center;gap:12px;margin:7px 0}}
  .barrow .lab{{font-size:13px;text-align:right;color:var(--ink)}}
  .barrow .val{{font-size:13px;color:var(--muted);white-space:nowrap}}
  .track{{background:#eef1f6;border-radius:6px;height:22px;overflow:hidden}}
  .fill{{height:100%;border-radius:6px;display:flex;align-items:center;justify-content:flex-end;padding-right:8px;color:#fff;font-size:12px;font-weight:600;min-width:44px}}
  .fill.blue{{background:var(--blue)}}
  .hyp .hyphead{{display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap}}
  .hyp h3{{margin:0;font-size:16px}}
  .mchips{{display:flex;gap:8px;flex-wrap:wrap}}
  .mchip{{border:2px solid;border-radius:8px;padding:4px 10px;font-size:13px;background:#fff}}
  .mchip small{{color:var(--muted)}}
  table.pk td{{border-bottom:none;padding:3px 8px;font-size:13px}}
  td.pklab{{color:var(--muted);white-space:nowrap;width:80px;font-weight:600;vertical-align:top}}
  .readme li,.tight li{{margin:6px 0;line-height:1.55}}
  ul.tight{{margin:8px 0;padding-left:20px}}
  dl.glossary{{margin:0}}
  dl.glossary dt{{font-weight:700;margin-top:12px}}
  dl.glossary dd{{margin:4px 0 0 0;color:var(--muted);font-size:14px;line-height:1.55}}
  .toc{{columns:2;gap:24px;font-size:14px}}
  .toc a{{display:block;margin:4px 0}}
  @media(max-width:700px){{.toc{{columns:1}}}}
</style>
</head>
<body><div class="wrap">

<header class="hero">
  <h1>Phase A Briefing — Clean-Room Catalog, Shortlist &amp; Hypotheses</h1>
  <p>A self-contained guide to what we pulled from public sources on 2026-07-07, how the
     12-model shortlist was ranked, and what the five hypothesis cards commit us to test —
     before spending any API money. All numbers trace to committed repo artifacts.</p>
  <div class="chips">
    <span class="chip">OpenRouter rows <b>{snap["total_rows_in_api"]}</b></span>
    <span class="chip">candidates <b>{len(candidates)}</b></span>
    <span class="chip">shortlist <b>{len(shortlist)}</b></span>
    <span class="chip">hypotheses <b>{len(cards)}</b></span>
    <span class="chip">API spend <b>$0</b></span>
    <span class="chip">retrieved <b>{esc(snap["retrieved_at"])}</b></span>
  </div>
</header>

<div class="card">
  <h3>Table of contents</h3>
  <div class="toc">
    <a href="#start">0 — What is Phase A?</a>
    <a href="#funnel">1 — Catalog funnel (343 → 34)</a>
    <a href="#value">2 — Value map (price vs score)</a>
    <a href="#coverage">3 — Evidence coverage matrix</a>
    <a href="#shortlist">4 — The 12-model shortlist</a>
    <a href="#hypotheses">5 — Five hypothesis cards</a>
    <a href="#read">6 — How to read this briefing</a>
    <a href="#sources">7 — Data sources &amp; artifacts</a>
    <a href="#glossary">8 — Glossary</a>
  </div>
</div>

<h2 id="start"><span class="num">0</span>What is Phase A?</h2>
<p class="sub">Phase A is the <b>hypothesis formation</b> step of the clean-room ensemble launch plan
({link("https://github.com/velum-labs/handoffkit/blob/main/docs/fusion/ensemble-launch-clean-room-2026-07.md", "ensemble-launch-clean-room-2026-07.md")}).
It answers: <i>which open-source model panels should we try?</i> — not <i>which panel wins?</i></p>

<div class="callout">
  <b>Clean room</b> means every model name, price, and score was pulled fresh from public APIs and
  leaderboards on 2026-07-07. Selection rules were written <i>before</i> looking at rankings.
  Prior internal shortlists and experiment conclusions were deliberately <b>not</b> used as input.
  If Phase A lands on similar panels to older docs, that is convergence; if not, we learned the
  old lists were stale.
</div>

<p class="prose">Phase A produces three committed artifact types:</p>
<ul class="tight">
  <li><b>Catalog snapshot</b> — every candidate OSS coding model on OpenRouter with slug, price,
      context, provider options, lineage tag, and third-party benchmark scores (each with URL).</li>
  <li><b>Shortlist (8–12 models)</b> — ranked by a pre-committed simple mean of public scores.
      Used only for shortlisting, not for launch claims.</li>
  <li><b>Hypothesis cards (H1–H5)</b> — falsifiable panel configs with pinned model IDs, judge,
      cost projections, predictions, and kill conditions. Written before any billed run.</li>
</ul>
<p class="prose">Phase A spends <b>$0</b> on API calls. The first real measurements happen in
<b>Phase C</b> (~$25–75) on a fixed task manifest we grade ourselves. Nothing in this briefing is
publishable as a product score.</p>

<h2 id="funnel"><span class="num">1</span>The funnel: {snap["total_rows_in_api"]} API rows → {len(candidates)} candidates</h2>
<p class="sub">Step 2 of Phase A: enumerate the live OpenRouter catalog and apply <b>mechanical
filters only</b>. No model was dropped for "not scoring high enough" — score-based selection
happens later, in Step 4 (shortlist), using rules written in advance.</p>
<p class="prose"><b>Primary data source:</b> {link(snap["source_url"], snap["source_url"])} — pulled at
<code>{esc(snap["retrieved_at"])}</code>. Filtered raw rows for surviving candidates are archived at
<code>labruns/2026-q3/catalog/openrouter-rows-2026-07-07.json</code>.</p>
<div class="card">
<table><thead><tr><th>Filter (rule)</th><th class="num">Removed</th><th class="num">Remaining</th></tr></thead>
<tbody>{"".join(ledger_rows)}</tbody></table>
</div>
<p class="sub">Judgment calls for borderline rows (e.g. which variant slugs count as duplicates,
which multimodal models count as coding-capable) are documented in
<code>docs/fusion/catalog-snapshot-2026-07-07.md</code> under "Judgment calls".</p>

<h2 id="value"><span class="num">2</span>Value map: what you pay vs what leaderboards say</h2>
<p class="sub">Each dot is one shortlisted or candidate model that has a computed
<code>aggregate_mean</code>. The Y axis is the simple unweighted mean of third-party, unsaturated
benchmark scores (0–100 scale). The X axis is <b>blended request cost</b> at a fixed token budget.</p>
<div class="callout">
  <b>Cost formula (per model, per request):</b><br>
  <code>cost = (2,000 × input_price_per_M + 8,000 × output_price_per_M) / 1,000,000</code><br>
  Prices come from the OpenRouter API fields <code>pricing.prompt</code> and
  <code>pricing.completion</code>, converted to USD per million tokens in the snapshot YAML.
  This is a <i>planning estimate</i> for comparing models — actual Phase C spend depends on
  real output lengths per task.
</div>
<p class="prose"><b>How to read the chart:</b> up-and-left is better (higher public mean, lower
cost). <b>Black-ring dots</b> are panel members in at least one hypothesis.
<b>Amber-ring dot</b> is the judge (<code>{esc(judge_slug)}</code>). Family color matches the
lineage legend in section 3. Hover any dot for exact mean and $/request.</p>
<div class="card">{scatter_svg(candidates, panel_slugs, judge_slug)}</div>
<p class="sub"><b>Frontier price envelope:</b> GPT-5.5-class closed model pricing is
${ANCHOR_IN_PER_M}/M input and ${ANCHOR_OUT_PER_M}/M output
(source: {link(ANCHOR_PRICE_URL, "aicost.tools GPT-5.5 page")}, retrieved 2026-07-07).
At the same 2k/8k token budget that is <b>${anchor_cost:.4f}/request</b>. Panel members must
collectively stay below <b>⅓ ≈ ${envelope:.4f}</b> — all current hypotheses pass this veto.</p>

<h2 id="coverage"><span class="num">3</span>Evidence coverage: how much do we actually know?</h2>
<p class="sub">Step 3 of Phase A: collect third-party benchmark aggregates for every candidate.
Each score in the table links to the exact leaderboard page it came from. Hover a cell for the
full harness description and retrieval date.</p>
<div class="callout warn">
  <b>Most important caveat:</b> {tp_count} of {len(candidates)} candidates have at least one
  third-party score; <b>{none_count}</b> have none at all
  ({", ".join(f"<code>{esc(s)}</code>" for s in none_models)}).
  Ranks built on <b>one</b> benchmark (e.g. ranks 1–2 on LiveCodeBench only) are weaker than ranks
  averaging two or three benchmarks. This asymmetry was recorded in the snapshot prose and was
  <b>not</b> corrected by re-ranking — changing rules after seeing results would break clean-room
  discipline. Phase C supersedes this entirely by measuring all 12 shortlist models on one harness.
</div>
<p class="prose"><b>Benchmarks used for ranking (Step 4):</b></p>
{benchmark_explainer()}
<div class="card" style="max-height:560px;overflow-y:auto">{coverage_matrix(candidates)}</div>
<div class="legend">
  <span class="cov tp">third-party — counts toward mean</span>
  <span class="cov vendor">vendor-claimed — excluded</span>
  <span class="cov sat">saturated — excluded</span>
  <span class="cov none" style="background:#eef1f6">- no data</span>
</div>
<p class="sub"><b>Ranking mean formula:</b> for each model, take the simple arithmetic mean of all
<code>coding_evidence</code> entries where <code>trust: third-party</code> and
<code>saturated: false</code>. Fractional scores (0–1) are multiplied by 100 before averaging.
Vendor-claimed and saturated rows are ignored. Models with no qualifying scores get
<code>aggregate_mean: null</code> and cannot anchor H1.</p>

<h2 id="shortlist"><span class="num">4</span>The shortlist: 12 models by simple unweighted mean</h2>
<p class="sub">Step 4 of Phase A. Highlighted rows are used in at least one hypothesis card
(panel member or judge). The "Evidence" column lists which benchmarks contributed to the mean.</p>
<div class="card">
<table><thead><tr><th class="num">#</th><th>Model (OpenRouter slug)</th><th class="num">Mean</th>
<th>Benchmarks in mean</th><th>Lineage family</th><th class="num">$/request</th></tr></thead>
<tbody>{"".join(shortlist_rows)}</tbody></table>
</div>
<p class="sub">Mechanical filters also applied: at least one model ≤ $0.20/M input for cascade
fodder (nemotron, dsv4-flash, mistral-small, qwen3-235b satisfy this); lineage veto enforced
when building panels (at most one model per base family per panel). Full shortlist table with
flags is in <code>docs/fusion/catalog-snapshot-2026-07-07.md</code>.</p>

<h2 id="hypotheses"><span class="num">5</span>The five bets: hypothesis cards at a glance</h2>
<p class="sub">Step 5–6 of Phase A. Each card is a preregistered experiment config. Costs below
use the shared token model; full reasoning is in <code>labruns/2026-q3/hypotheses/*.md</code>.
Pinned model identities and hashes live in
<code>python/fusionkit-lab/registry/2026-q3.yaml</code>.</p>
<div class="callout">
  <b>Shared judge (H1, H2, H5):</b> <code>qwen/qwen3.7-max</code> — chosen because it is a strong
  instruction-following model that is <b>not</b> a member of those panels. Judge cost per fused
  request: ~15k input tokens (all panel answers) + ~4k output ≈ $0.034 at snapshot prices.
  <b>H4 has no judge</b> — it is the Self-MoA routing baseline.
</div>
{hypothesis_section(cards, slug_meta)}

<h2 id="read"><span class="num">6</span>How to read all of this</h2>
<div class="card readme">
<ul>
<li><b>Nothing here is a measured result.</b> Phase A produces <i>hypotheses</i>, not pass rates on
our product harness. The shortlist mean is a shortlisting heuristic over incompatible public
harnesses. Treat it as "which models are worth spending Phase C money on," not "which model is
best."</li>
<li><b>What each hypothesis tests:</b>
  <ul class="tight">
    <li><b>H1</b> — Does the honest top-3 backbone beat best-single?</li>
    <li><b>H2</b> — Does near-tie style diversity beat pure rank?</li>
    <li><b>H3</b> — Does cheap-first cascade win on $/solve? (deferred until cascade exists)</li>
    <li><b>H4</b> — Does one strong model × 3 samples make panels pointless? <i>Mandatory baseline.</i></li>
    <li><b>H5</b> — Do 64k thinking budgets buy measurable headroom?</li>
  </ul>
</li>
<li><b>Acceptable outcomes:</b> "H4 wins → ship routing preset, not fusion" is a fully valid
shippable verdict. "All panels lose → back to drawing board" is also valid. The kill conditions on
each card define what falsifies each bet.</li>
<li><b>What comes next (Phase B):</b> emit FusionKit fusion configs from these cards, run cent-scale
smoke tests (model IDs resolve, streaming works), and commit a measurement preregistration before
Phase C spends real money.</li>
<li><b>Regenerate this page</b> after any snapshot or card change:
<code>uv run python analysis/phase-a-briefing-2026-07-07/scripts/build_briefing.py</code></li>
</ul>
</div>

<h2 id="sources"><span class="num">7</span>Data sources &amp; committed artifacts</h2>
<p class="sub">Every number in this briefing should trace to one of these sources. Per-model score
cells in section 3 link directly to the leaderboard row's page.</p>
<div class="card" style="max-height:480px;overflow-y:auto">
{sources_table(source_rows)}
</div>

<h2 id="glossary"><span class="num">8</span>Glossary</h2>
<div class="card">
<dl class="glossary">
  <dt>Panel</dt>
  <dd>2–4 models that all attempt the same coding task in parallel before a judge merges answers.</dd>
  <dt>Ensemble / fusion</dt>
  <dd>A panel plus the machinery that merges answers (topology + judge). What FusionKit sells as a named product.</dd>
  <dt>Judge / synthesizer</dt>
  <dd>The model that reads all panel members' answers and produces one final response.</dd>
  <dt>Self-MoA (H4)</dt>
  <dd>One strong model sampled K times; keep the best answer via execution-guided grading. No judge.</dd>
  <dt>Lineage veto</dt>
  <dd>At most one model per base family per panel — clones from the same teacher fail on the same tasks.</dd>
  <dt>Aggregate mean</dt>
  <dd>Simple unweighted mean of third-party, unsaturated benchmark scores for shortlisting only.</dd>
  <dt>Oracle (panel ceiling)</dt>
  <dd>Theoretical max: pass if any panel member passes. Diagnostic only — computed in Phase C, not Phase A.</dd>
  <dt>Headroom</dt>
  <dd>Oracle minus best-single pass rate. Room for fusion to help if members fail on different tasks.</dd>
  <dt>Truncation refusal</dt>
  <dd>If &gt;10% of a model's answers are cut off mid-stream at the practical budget, its score is refused (Phase C rule).</dd>
  <dt>Evidence card</dt>
  <dd>Publishable one-pager with measured score + cost — only Phase D produces these.</dd>
</dl>
</div>

<p class="sub" style="margin-top:30px">Generated from committed artifacts by
<code>analysis/phase-a-briefing-2026-07-07/scripts/build_briefing.py</code> on demand.
Primary inputs: <code>docs/fusion/catalog-snapshot-2026-07-07.yaml</code>,
<code>labruns/2026-q3/hypotheses/*.md</code>.</p>

</div></body></html>
"""
    OUT.write_text(page, encoding="utf-8")
    print(f"wrote {OUT} ({len(page):,} bytes)")


if __name__ == "__main__":
    build()
