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

# Monochrome design system — no per-family rainbow colors.
DOT_FILL = "#404040"
DOT_MUTED = "#b0b0b0"
DOT_PANEL_STROKE = "#111111"
DOT_JUDGE_STROKE = "#111111"

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


def meta(label: str, title: str = "") -> str:
    title_attr = f' title="{esc(title)}"' if title else ""
    return f'<span class="meta"{title_attr}>{esc(label)}</span>'


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


def reading_guide(judge_slug: str) -> str:
    judge = judge_slug or "judge"
    return f"""
<aside class="guide" id="visual-key">
  <h3>Reading guide</h3>
  <dl class="deflist">
    <dt>Evidence scores</dt>
    <dd><strong>Plain number</strong> — third-party leaderboard; counts toward the ranking mean (click to open source).
        <strong>Number†</strong> — vendor-claimed; recorded but excluded.
        <strong>Number°</strong> — saturated benchmark; excluded.
        <strong>—</strong> — no public score.</dd>
    <dt>Shortlist roles</dt>
    <dd>{meta("panel")} member of a hypothesis panel. {meta("judge")} synthesizer only. Rows with a left rule are used in a hypothesis.</dd>
    <dt>Evidence depth</dt>
    <dd>Mean from ≥2 benchmarks is more reliable than a mean from one benchmark alone.</dd>
    <dt>Scatter chart</dt>
    <dd><strong>Filled dot</strong> — panel member. <strong>Ring</strong> — judge ({esc(judge)}). <strong>Small dot</strong> — other ranked candidates. Up and left is better (higher mean, lower cost).</dd>
    <dt>Hypothesis cards</dt>
    <dd>{meta("ready")} runnable in Phase B. {meta("deferred")} written but blocked on engineering. <em>predicts</em> / <em>killed if</em> are preregistered falsification rules.</dd>
  </dl>
</aside>"""


def section_note(title: str, body: str) -> str:
    return f'<aside class="note"><strong>{esc(title)}</strong> {body}</aside>'


def funnel_key() -> str:
    return section_note(
        "Funnel columns",
        "Filter applies in order. Removed = rows dropped by that step only. Remaining = rows passed to the next filter. No scores involved.",
    )


def scatter_key() -> str:
    return section_note(
        "Axes",
        "Vertical: aggregate mean (0–100) from third-party, non-saturated benchmarks. "
        "Horizontal: estimated $/request at 2k input + 8k output tokens (log scale). "
        "Not a Phase C measurement.",
    )


def coverage_key() -> str:
    return section_note(
        "Matrix",
        "Hover a score for harness text and retrieval date. Mean column averages plain numbers only.",
    )


def shortlist_key() -> str:
    return section_note(
        "Columns",
        "# is rank by mean. Benchmarks lists which leaderboards contributed. $/request uses the same token model as the chart.",
    )


def hypothesis_key() -> str:
    return section_note(
        "Cost bars",
        "Estimated Phase C spend for 60 tasks; bar length is relative to the most expensive hypothesis.",
    )


def hero_stats(snap: dict[str, Any], candidates: int, shortlist: int, cards: int) -> str:
    return f"""
<dl class="stats">
  <div><dt>OpenRouter rows</dt><dd>{snap["total_rows_in_api"]}</dd></div>
  <div><dt>Candidates</dt><dd>{candidates}</dd></div>
  <div><dt>Shortlist</dt><dd>{shortlist}</dd></div>
  <div><dt>Hypotheses</dt><dd>{cards}</dd></div>
  <div><dt>API spend</dt><dd>$0</dd></div>
  <div><dt>Retrieved</dt><dd>{esc(snap["retrieved_at"])}</dd></div>
</dl>"""


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
        f'style="width:100%;height:auto;background:transparent">'
    ]
    grid_stroke = "#ebebeb"
    text_muted = "#888888"
    for tick in [0.001, 0.003, 0.01, 0.03]:
        if xmin <= math.log10(tick) <= xmax:
            x = sx(tick)
            parts.append(f'<line x1="{x:.1f}" y1="{pad_t}" x2="{x:.1f}" y2="{height - pad_b}" stroke="{grid_stroke}"/>')
            parts.append(
                f'<text x="{x:.1f}" y="{height - pad_b + 18}" text-anchor="middle" font-size="11" fill="{text_muted}">'
                f"${tick:g}</text>"
            )
    for tick in range(int(ymin // 10 + 1) * 10, int(ymax) + 1, 10):
        y = sy(tick)
        parts.append(f'<line x1="{pad_l}" y1="{y:.1f}" x2="{width - pad_r}" y2="{y:.1f}" stroke="{grid_stroke}"/>')
        parts.append(
            f'<text x="{pad_l - 8}" y="{y + 4:.1f}" text-anchor="end" font-size="11" fill="{text_muted}">{tick}</text>'
        )
    parts.append(
        f'<text x="{(pad_l + width - pad_r) / 2:.0f}" y="{height - 8}" text-anchor="middle" font-size="11" '
        f'fill="{text_muted}">cost per request (USD, log scale)</text>'
    )
    parts.append(
        f'<text x="14" y="{(pad_t + height - pad_b) / 2:.0f}" text-anchor="middle" font-size="11" fill="{text_muted}" '
        f'transform="rotate(-90 14 {(pad_t + height - pad_b) / 2:.0f})">aggregate mean</text>'
    )

    labeled = {c["slug"] for c in sorted(points, key=lambda c: -c["aggregate_mean"])[:10]}
    for cand in sorted(points, key=lambda c: c["aggregate_mean"]):
        slug = cand["slug"]
        x, y = sx(blended_request_cost(cand["pricing"])), sy(cand["aggregate_mean"])
        in_panel, is_judge = slug in panel_slugs, slug == judge_slug
        if is_judge:
            radius, fill, stroke, sw = 7, "#fff", DOT_JUDGE_STROKE, 2
        elif in_panel:
            radius, fill, stroke, sw = 6.5, DOT_FILL, DOT_PANEL_STROKE, 1.5
        else:
            radius, fill, stroke, sw = 4.5, DOT_MUTED, DOT_MUTED, 1
        parts.append(
            f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{radius}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}">'
            f"<title>{esc(slug)} — mean {cand['aggregate_mean']:.1f}, "
            f"${blended_request_cost(cand['pricing']):.4f}/req</title></circle>"
        )
        if slug in labeled:
            name = slug.split("/", 1)[1]
            anchor, dx = ("start", 10) if x < width - 200 else ("end", -10)
            parts.append(
                f'<text x="{x + dx:.1f}" y="{y + 3.5:.1f}" text-anchor="{anchor}" font-size="10.5" '
                f'fill="#333">{esc(name)}</text>'
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
                cells.append('<td class="cov none">—</td>')
                continue
            score = norm_score(float(entry["score"]))
            if entry.get("saturated"):
                suffix, cls, note = "°", "sat", "saturated — excluded from ranking mean"
            elif entry.get("trust") == "vendor-claimed":
                suffix, cls, note = "†", "vendor", "vendor-claimed — excluded from ranking mean"
            else:
                suffix, cls, note = "", "tp", "third-party — included in ranking mean"
            url = entry.get("url", "")
            score_html = link(url, f"{score:.1f}{suffix}") if url else f"{score:.1f}{suffix}"
            title = esc(f"{note}. {entry.get('harness', '')} (as_of: {entry.get('as_of', '?')})")
            cells.append(f'<td class="cov {cls}" title="{title}">{score_html}</td>')
        mean = cand.get("aggregate_mean")
        mean_txt = f"{mean:.1f}" if mean is not None else '<span class="mut">—</span>'
        flags = " ".join(meta(f, f"catalog flag: {f}") for f in cand.get("flags") or [])
        rows.append(
            f'<tr><td><code>{esc(cand["slug"])}</code> {flags}</td>'
            f'<td class="mut">{esc(cand["lineage"]["base_family"])}</td>{"".join(cells)}'
            f'<td class="num">{mean_txt}</td></tr>'
        )
    heads = "".join(
        f'<th title="{esc(BENCHMARK_META[key]["what"])}">{label}</th>'
        for key, label in BENCHMARKS
    )
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


def hypothesis_section(cards: list[dict[str, Any]], _slug_meta: dict[str, dict[str, Any]]) -> str:
    max_sweep = max(float(c["cost_projection"]["sweep_60_tasks_usd"]) for c in cards)
    blocks = []
    for card in cards:
        hid = card["hypothesis_id"]
        status = card["status"]
        blurb = HYPOTHESIS_BLURBS.get(hid, "")
        members = []
        for member in card.get("panel") or []:
            budget_k = member["max_completion_tokens"] // 1024
            members.append(
                f"<li><code>{esc(member['slug'])}</code> "
                f'<span class="mut">{budget_k}k cap</span></li>'
            )
        judge = card.get("judge") or {}
        if judge.get("slug"):
            judge_txt = f"Judge: <code>{esc(judge['slug'])}</code>"
        else:
            judge_txt = "No judge — execution-guided best-of-N (H4)"
        k_samples = (card.get("sampling") or {}).get("k_samples", 1)
        per_req = float(card["cost_projection"]["per_request_usd"])
        sweep = float(card["cost_projection"]["sweep_60_tasks_usd"])
        bar_pct = max(sweep / max_sweep * 100, 3)
        blocks.append(f"""
<article class="hyp" id="{esc(hid)}">
  <header class="hyphead">
    <h3>{esc(hid)}</h3>
    <span class="hypmeta">{meta(status)} {meta(card["topology"])} K={k_samples}</span>
  </header>
  <p class="lede">{esc(blurb)}</p>
  <ul class="panel-list">{"".join(members)}</ul>
  <p class="mut">{judge_txt}</p>
  <div class="costrow">
    <span class="costlab">60-task sweep</span>
    <div class="costtrack"><div class="costfill" style="width:{bar_pct:.0f}%"></div></div>
    <span class="costval">${sweep:.2f} <span class="mut">(${per_req:.4f}/req)</span></span>
  </div>
  <dl class="verdict">
    <dt>predicts</dt><dd>{esc(card["prediction"])}</dd>
    <dt>killed if</dt><dd>{esc(card["kill_condition"])}</dd>
    <dt>source</dt><dd><code>labruns/2026-q3/hypotheses/{esc(hid)}.md</code></dd>
  </dl>
</article>""")
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
        bench_note = (
            f"{bench_count} benchmark{'s' if bench_count != 1 else ''}"
            if bench_count
            else "no qualifying benchmarks"
        )
        bench_span = (
            f'<span class="ev{" thin" if 0 < bench_count < 2 else ""}">{esc(bench_note)}</span>'
        )
        in_use = cand["slug"] in panel_slugs or cand["slug"] == judge_slug
        role = ""
        if cand["slug"] in panel_slugs:
            role = meta("panel")
        elif cand["slug"] == judge_slug:
            role = meta("judge")
        bench_names = ", ".join(benches) if benches else "—"
        shortlist_rows.append(
            f'<tr{" class=featured" if in_use else ""}><td class="num">{rank}</td>'
            f'<td><code>{esc(cand["slug"])}</code> {role}</td>'
            f'<td class="num">{cand["aggregate_mean"]:.1f}</td>'
            f'<td>{bench_span}'
            f'<br><span class="mut" style="font-size:12px">{esc(bench_names)}</span></td>'
            f'<td class="mut">{esc(cand["lineage"]["base_family"])}</td>'
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
<title>Phase A briefing — catalog, shortlist, hypotheses (2026-07-07)</title>
<style>
  :root{{--ink:#111;--muted:#666;--faint:#999;--line:#e5e5e5;--bg:#fff;--surface:#fafafa;--rule:#111}}
  *{{box-sizing:border-box}}
  html{{scroll-behavior:smooth}}
  body{{margin:0;font:16px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:var(--bg);-webkit-font-smoothing:antialiased}}
  .wrap{{max-width:720px;margin:0 auto;padding:48px 24px 96px}}
  header.mast{{border-bottom:1px solid var(--line);padding-bottom:32px;margin-bottom:40px}}
  header.mast .eyebrow{{margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--faint);font-weight:600}}
  header.mast h1{{margin:0 0 12px;font-size:1.75rem;font-weight:600;letter-spacing:-.02em;line-height:1.25}}
  header.mast .deck{{margin:0;color:var(--muted);font-size:1rem;max-width:58ch}}
  .prose{{color:var(--muted);margin:0 0 12px;font-size:15px;line-height:1.65;max-width:62ch}}
  dl.stats{{display:grid;grid-template-columns:repeat(3,1fr);gap:16px 24px;margin:28px 0 0;padding:0}}
  dl.stats div{{margin:0}}
  dl.stats dt{{margin:0;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--faint)}}
  dl.stats dd{{margin:4px 0 0;font-size:15px;font-variant-numeric:tabular-nums}}
  nav.toc{{border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:20px 0;margin:0 0 40px}}
  nav.toc h2{{margin:0 0 12px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--faint);font-weight:600}}
  nav.toc ol{{margin:0;padding-left:20px;color:var(--muted);font-size:14px}}
  nav.toc li{{margin:6px 0}}
  nav.toc a{{color:var(--ink);text-decoration:none}}
  nav.toc a:hover{{text-decoration:underline}}
  aside.guide{{background:var(--surface);border:1px solid var(--line);padding:20px 22px;margin-bottom:40px}}
  aside.guide h3{{margin:0 0 14px;font-size:14px;font-weight:600}}
  dl.deflist{{margin:0;font-size:14px}}
  dl.deflist dt{{font-weight:600;margin:14px 0 4px}}
  dl.deflist dt:first-child{{margin-top:0}}
  dl.deflist dd{{margin:0 0 0 0;color:var(--muted);line-height:1.6}}
  section{{margin:48px 0}}
  section>h2{{margin:0 0 8px;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--faint);display:flex;align-items:baseline;gap:10px}}
  section>h2 .idx{{color:var(--ink);font-variant-numeric:tabular-nums}}
  .lede,.sub{{color:var(--muted);margin:0 0 20px;font-size:15px;line-height:1.65;max-width:62ch}}
  .lede strong,.sub strong{{color:var(--ink);font-weight:600}}
  aside.note{{margin:0 0 16px;padding:12px 0 12px 14px;border-left:2px solid var(--line);font-size:14px;color:var(--muted);line-height:1.6}}
  aside.note strong{{color:var(--ink);font-weight:600}}
  aside.caveat{{margin:16px 0;padding:14px 16px;background:var(--surface);border-left:2px solid var(--rule);font-size:14px;line-height:1.6;color:var(--muted)}}
  aside.caveat strong{{color:var(--ink)}}
  .panel{{border:1px solid var(--line);padding:0;margin:0 0 16px;overflow-x:auto}}
  .panel.scroll{{max-height:520px;overflow-y:auto}}
  table{{width:100%;border-collapse:collapse;font-size:13.5px}}
  th{{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--faint);font-weight:600;padding:10px 12px;border-bottom:1px solid var(--line);white-space:nowrap}}
  td{{padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:top}}
  tr:last-child td{{border-bottom:none}}
  td.num,th.num{{text-align:right;font-variant-numeric:tabular-nums}}
  tr.featured td:first-child{{box-shadow:inset 3px 0 0 var(--rule)}}
  code{{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:.88em}}
  a{{color:var(--ink);text-decoration:underline;text-underline-offset:2px}}
  a:hover{{text-decoration-thickness:2px}}
  .mut{{color:var(--muted)}}
  .meta{{display:inline-block;font-size:10px;text-transform:uppercase;letter-spacing:.05em;padding:1px 6px;border:1px solid var(--line);color:var(--muted);margin-left:4px;vertical-align:1px}}
  .cov{{text-align:right;font-variant-numeric:tabular-nums}}
  .cov.tp a{{font-weight:500;text-decoration:none}}
  .cov.tp a:hover{{text-decoration:underline}}
  .cov.vendor,.cov.sat{{color:var(--faint)}}
  .cov.none{{color:var(--faint);text-align:center}}
  .ev.thin{{font-style:italic;color:var(--faint)}}
  ul.tight{{margin:8px 0 16px;padding-left:20px;color:var(--muted);font-size:15px}}
  ul.tight li{{margin:6px 0}}
  article.hyp{{border-top:1px solid var(--line);padding:28px 0}}
  article.hyp:first-of-type{{border-top:none;padding-top:0}}
  .hyphead{{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:8px}}
  .hyphead h3{{margin:0;font-size:17px;font-weight:600}}
  .hypmeta{{font-size:13px;color:var(--muted)}}
  ul.panel-list{{margin:12px 0;padding-left:18px;font-size:14px}}
  ul.panel-list li{{margin:4px 0}}
  .costrow{{display:grid;grid-template-columns:88px 1fr auto;gap:12px;align-items:center;margin:16px 0;font-size:13px}}
  .costlab{{text-align:right;color:var(--muted)}}
  .costtrack{{height:3px;background:var(--line)}}
  .costfill{{height:100%;background:var(--ink)}}
  .costval{{font-variant-numeric:tabular-nums;white-space:nowrap}}
  dl.verdict{{margin:16px 0 0;font-size:14px;display:grid;grid-template-columns:72px 1fr;gap:6px 12px}}
  dl.verdict dt{{color:var(--faint);font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin:0}}
  dl.verdict dd{{margin:0;color:var(--muted);line-height:1.55}}
  dl.glossary{{margin:0;font-size:14px}}
  dl.glossary dt{{font-weight:600;margin:16px 0 4px}}
  dl.glossary dt:first-child{{margin-top:0}}
  dl.glossary dd{{margin:0;color:var(--muted);line-height:1.6}}
  footer{{margin-top:64px;padding-top:20px;border-top:1px solid var(--line);font-size:13px;color:var(--faint)}}
  @media(max-width:600px){{dl.stats{{grid-template-columns:1fr 1fr}} .costrow{{grid-template-columns:1fr;gap:6px}}}}
</style>
</head>
<body><div class="wrap">

<header class="mast">
  <p class="eyebrow">FusionKit Lab · Phase A</p>
  <h1>Capability index briefing</h1>
  <p class="deck">Public catalog pull, mechanical shortlist, and preregistered hypothesis cards — before any billed fusion run. All numbers trace to committed repo artifacts.</p>
  {hero_stats(snap, len(candidates), len(shortlist), len(cards))}
</header>

<nav class="toc">
  <h2>Contents</h2>
  <ol>
    <li><a href="#visual-key">Reading guide</a></li>
    <li><a href="#start">What is Phase A?</a></li>
    <li><a href="#funnel">Catalog funnel</a></li>
    <li><a href="#value">Score vs cost</a></li>
    <li><a href="#coverage">Evidence coverage</a></li>
    <li><a href="#shortlist">Shortlist</a></li>
    <li><a href="#hypotheses">Hypothesis cards</a></li>
    <li><a href="#read">How to read this</a></li>
    <li><a href="#sources">Sources</a></li>
    <li><a href="#glossary">Glossary</a></li>
  </ol>
</nav>

{reading_guide(judge_slug)}

<section id="start">
  <h2><span class="idx">0</span> What is Phase A?</h2>
  <p class="sub">Phase A is the <strong>hypothesis formation</strong> step of the clean-room ensemble launch plan
  ({link("https://github.com/velum-labs/handoffkit/blob/main/docs/fusion/ensemble-launch-clean-room-2026-07.md", "ensemble-launch-clean-room-2026-07.md")}).
  It answers: <em>which open-source model panels should we try?</em> — not <em>which panel wins?</em></p>
  <aside class="caveat">
    <strong>Clean room.</strong> Every model name, price, and score was pulled fresh from public APIs and
    leaderboards on 2026-07-07. Selection rules were written before looking at rankings.
    Prior internal shortlists were deliberately not used as input.
  </aside>
  <p class="prose">Phase A produces three committed artifact types:</p>
  <ul class="tight">
    <li><strong>Catalog snapshot</strong> — every candidate OSS coding model on OpenRouter with slug, price,
        context, provider options, lineage tag, and third-party benchmark scores (each with URL).</li>
    <li><strong>Shortlist (8–12 models)</strong> — ranked by a pre-committed simple mean of public scores.
        Used only for shortlisting, not for launch claims.</li>
    <li><strong>Hypothesis cards (H1–H5)</strong> — falsifiable panel configs with pinned model IDs, judge,
        cost projections, predictions, and kill conditions. Written before any billed run.</li>
  </ul>
  <p class="prose">Phase A spends <strong>$0</strong> on API calls. The first real measurements happen in
  <strong>Phase C</strong> (~$25–75) on a fixed task manifest we grade ourselves.</p>
</section>

<section id="funnel">
  <h2><span class="idx">1</span> Catalog funnel</h2>
  <p class="sub">{snap["total_rows_in_api"]} OpenRouter API rows → {len(candidates)} candidates after mechanical filters.
  No model was dropped for scoring low — score-based selection happens in Step 4 (shortlist).</p>
  <p class="prose"><strong>Source:</strong> {link(snap["source_url"], snap["source_url"])} — pulled at
  <code>{esc(snap["retrieved_at"])}</code>. Raw rows archived at
  <code>labruns/2026-q3/catalog/openrouter-rows-2026-07-07.json</code>.</p>
  {funnel_key()}
  <div class="panel">
    <table><thead><tr><th>Filter (rule)</th><th class="num" title="Rows removed by this filter only">Removed</th><th class="num" title="Rows surviving after this filter">Remaining</th></tr></thead>
    <tbody>{"".join(ledger_rows)}</tbody></table>
  </div>
  <p class="sub">Borderline judgment calls are documented in
  <code>docs/fusion/catalog-snapshot-2026-07-07.md</code>.</p>
</section>

<section id="value">
  <h2><span class="idx">2</span> Score vs cost</h2>
  <p class="sub">Each dot is one candidate with a computed <code>aggregate_mean</code>.
  Vertical axis: simple mean of third-party, unsaturated benchmark scores (0–100).
  Horizontal axis: blended request cost at a fixed token budget.</p>
  {section_note("Cost formula", "<code>(2,000 × input/M + 8,000 × output/M) / 1,000,000</code> — planning estimate from OpenRouter snapshot prices, not Phase C actuals.")}
  {scatter_key()}
  <div class="panel">{scatter_svg(candidates, panel_slugs, judge_slug)}</div>
  <p class="sub"><strong>Frontier envelope:</strong> GPT-5.5-class pricing is
  ${ANCHOR_IN_PER_M}/M input and ${ANCHOR_OUT_PER_M}/M output
  ({link(ANCHOR_PRICE_URL, "aicost.tools")}) → <strong>${anchor_cost:.4f}/request</strong> at 2k/8k tokens.
  Panel members must stay below <strong>⅓ ≈ ${envelope:.4f}</strong>; all current hypotheses pass.</p>
</section>

<section id="coverage">
  <h2><span class="idx">3</span> Evidence coverage</h2>
  <p class="sub">Third-party benchmark aggregates for every candidate. Hover a cell for harness text and retrieval date.
  Suffix <strong>†</strong> = vendor-claimed (excluded from mean); <strong>°</strong> = saturated benchmark (excluded).</p>
  <aside class="caveat">
    <strong>Coverage asymmetry.</strong> {tp_count} of {len(candidates)} candidates have at least one third-party score;
    <strong>{none_count}</strong> have none ({", ".join(f"<code>{esc(s)}</code>" for s in none_models)}).
    Ranks built on one benchmark (e.g. ranks 1–2 on LiveCodeBench only) are weaker than multi-benchmark ranks.
    This was recorded but not corrected by re-ranking — Phase C supersedes with one harness.
  </aside>
  <p class="prose"><strong>Benchmarks used for ranking:</strong></p>
  {benchmark_explainer()}
  {coverage_key()}
  <div class="panel scroll">{coverage_matrix(candidates)}</div>
  <p class="sub"><strong>Mean formula:</strong> arithmetic mean of entries where <code>trust: third-party</code> and
  <code>saturated: false</code>. Fractional scores (0–1) are multiplied by 100 before averaging.</p>
</section>

<section id="shortlist">
  <h2><span class="idx">4</span> Shortlist</h2>
  <p class="sub">Top {len(shortlist)} models by simple unweighted mean. Rows with a left rule are used in at least one hypothesis card.</p>
  {shortlist_key()}
  <div class="panel">
    <table><thead><tr><th class="num">#</th><th>Model</th><th class="num">Mean</th>
    <th>Benchmarks in mean</th><th>Family</th><th class="num">$/request</th></tr></thead>
    <tbody>{"".join(shortlist_rows)}</tbody></table>
  </div>
</section>

<section id="hypotheses">
  <h2><span class="idx">5</span> Hypothesis cards</h2>
  <p class="sub">Preregistered experiment configs. Costs use the shared 2k/8k token model.
  Full reasoning in <code>labruns/2026-q3/hypotheses/*.md</code>;
  pinned identities in <code>python/fusionkit-lab/registry/2026-q3.yaml</code>.</p>
  {section_note("Shared judge", "H1, H2, H5 use <code>qwen/qwen3.7-max</code> — strong instruction-following model not in those panels. H4 has no judge (Self-MoA baseline).")}
  {hypothesis_key()}
  {hypothesis_section(cards, slug_meta)}
</section>

<section id="read">
  <h2><span class="idx">6</span> How to read this</h2>
  <ul class="tight">
    <li><strong>Nothing here is a measured result.</strong> Phase A produces hypotheses, not pass rates on our harness.
    The shortlist mean is a shortlisting heuristic — "which models are worth Phase C money," not "which model is best."</li>
    <li><strong>What each hypothesis tests:</strong>
      <ul class="tight">
        <li><strong>H1</strong> — Does the honest top-3 backbone beat best-single?</li>
        <li><strong>H2</strong> — Does near-tie style diversity beat pure rank?</li>
        <li><strong>H3</strong> — Does cheap-first cascade win on $/solve? (deferred)</li>
        <li><strong>H4</strong> — Does one strong model × 3 samples make panels pointless?</li>
        <li><strong>H5</strong> — Do 64k thinking budgets buy measurable headroom?</li>
      </ul>
    </li>
    <li><strong>Valid outcomes:</strong> "H4 wins → ship routing, not fusion" and "all panels lose → back to drawing board" are both acceptable.</li>
    <li><strong>Next:</strong> Phase B emits fusion configs, runs cent-scale smoke tests, and commits measurement preregistration before Phase C.</li>
    <li><strong>Regenerate:</strong> <code>uv run python analysis/phase-a-briefing-2026-07-07/scripts/build_briefing.py</code></li>
  </ul>
</section>

<section id="sources">
  <h2><span class="idx">7</span> Sources</h2>
  <p class="sub">Every number should trace to one of these. Per-model score cells link directly to leaderboard pages.</p>
  <div class="panel scroll">
    {sources_table(source_rows)}
  </div>
</section>

<section id="glossary">
  <h2><span class="idx">8</span> Glossary</h2>
  <dl class="glossary">
    <dt>Panel</dt>
    <dd>2–4 models that all attempt the same coding task in parallel before a judge merges answers.</dd>
    <dt>Ensemble / fusion</dt>
    <dd>A panel plus the machinery that merges answers. What FusionKit sells as a named product.</dd>
    <dt>Judge / synthesizer</dt>
    <dd>The model that reads all panel members' answers and produces one final response.</dd>
    <dt>Self-MoA (H4)</dt>
    <dd>One strong model sampled K times; keep the best answer via execution-guided grading. No judge.</dd>
    <dt>Lineage veto</dt>
    <dd>At most one model per base family per panel — clones from the same teacher fail on the same tasks.</dd>
    <dt>Aggregate mean</dt>
    <dd>Simple unweighted mean of third-party, unsaturated benchmark scores for shortlisting only.</dd>
    <dt>Evidence marker</dt>
    <dd>Plain number = third-party (counts toward mean). † = vendor-claimed. ° = saturated benchmark. — = no score.</dd>
    <dt>Featured shortlist row</dt>
    <dd>Left rule indicates the model is a panel member or judge in at least one hypothesis card.</dd>
    <dt>Oracle (panel ceiling)</dt>
    <dd>Theoretical max: pass if any panel member passes. Computed in Phase C, not Phase A.</dd>
    <dt>Headroom</dt>
    <dd>Oracle minus best-single pass rate. Room for fusion to help if members fail on different tasks.</dd>
    <dt>Truncation refusal</dt>
    <dd>If &gt;10% of a model's answers are cut off mid-stream at the practical budget, its score is refused (Phase C rule).</dd>
    <dt>Evidence card</dt>
    <dd>Publishable one-pager with measured score + cost — only Phase D produces these.</dd>
  </dl>
</section>

<footer>
  Generated by <code>analysis/phase-a-briefing-2026-07-07/scripts/build_briefing.py</code>.
  Inputs: <code>docs/fusion/catalog-snapshot-2026-07-07.yaml</code>, <code>labruns/2026-q3/hypotheses/*.md</code>.
</footer>

</div></body></html>
"""
    OUT.write_text(page, encoding="utf-8")
    print(f"wrote {OUT} ({len(page):,} bytes)")


if __name__ == "__main__":
    build()
