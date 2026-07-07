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


def norm_score(value: float) -> float:
    """Leaderboards mix 0-1 fractions and 0-100 percentages; normalize to 0-100."""
    return value * 100 if value <= 1 else value


def esc(text: Any) -> str:
    return html.escape(str(text))


def family_color(family: str) -> str:
    return FAMILY_COLORS.get(family, DEFAULT_FAMILY_COLOR)


def blended_request_cost(pricing: dict[str, float]) -> float:
    return (REQ_IN_TOK * pricing["input_per_m"] + REQ_OUT_TOK * pricing["output_per_m"]) / 1e6


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
                cls, note = "sat", "saturated"
            elif entry.get("trust") == "vendor-claimed":
                cls, note = "vendor", "vendor-claimed"
            else:
                cls, note = "tp", "third-party"
            cells.append(f'<td class="cov {cls}" title="{esc(note)}: {esc(entry["harness"])}">{score:.1f}</td>')
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


def hypothesis_section(cards: list[dict[str, Any]], slug_meta: dict[str, dict[str, Any]]) -> str:
    max_sweep = max(float(c["cost_projection"]["sweep_60_tasks_usd"]) for c in cards)
    blocks = []
    for card in cards:
        hid = card["hypothesis_id"]
        status = card["status"]
        status_cls = {"ready": "pass", "deferred": "warn"}.get(status, "info")
        member_chips = []
        for member in card.get("panel") or []:
            slug = member["slug"]
            family = slug_meta.get(slug, {}).get("family", "?")
            budget_k = member["max_completion_tokens"] // 1024
            member_chips.append(
                f'<span class="mchip" style="border-color:{family_color(family)}">'
                f'<span class="fam" style="background:{family_color(family)}"></span>'
                f"{esc(slug.split('/', 1)[1])} <small>{budget_k}k</small></span>"
            )
        judge = card.get("judge") or {}
        judge_txt = (
            f'judge: <b>{esc(judge["slug"].split("/", 1)[1])}</b>'
            if judge.get("slug")
            else "judge: <b>none</b> (execution-guided selection)"
        )
        k_samples = (card.get("sampling") or {}).get("k_samples", 1)
        per_req = float(card["cost_projection"]["per_request_usd"])
        sweep = float(card["cost_projection"]["sweep_60_tasks_usd"])
        bar_pct = max(sweep / max_sweep * 100, 4)
        blocks.append(f"""
<div class="card hyp">
  <div class="hyphead">
    <h3>{esc(hid)}</h3>
    <span class="tag {status_cls}">{esc(status)}</span>
    <span class="tag info">{esc(card["topology"])}</span>
    <span class="tag dir">K={k_samples}</span>
  </div>
  <div class="mchips">{"".join(member_chips)}</div>
  <p class="sub" style="margin:8px 0 10px">{judge_txt}</p>
  <div class="barrow"><div class="lab">60-task sweep</div>
    <div class="track"><div class="fill blue" style="width:{bar_pct:.0f}%">${sweep:.2f}</div></div>
    <div class="val">${per_req:.4f}/request</div></div>
  <table class="pk"><tbody>
    <tr><td class="pklab">predicts</td><td>{esc(card["prediction"])}</td></tr>
    <tr><td class="pklab">killed if</td><td>{esc(card["kill_condition"])}</td></tr>
  </tbody></table>
</div>""")
    return "".join(blocks)


def build() -> None:
    snap = yaml.safe_load(SNAPSHOT.read_text(encoding="utf-8"))
    candidates = snap["candidates"]
    cards = load_cards()
    slug_meta = {c["slug"]: {"family": c["lineage"]["base_family"]} for c in candidates}

    panel_slugs = {m["slug"] for card in cards for m in card.get("panel") or []}
    judge_slug = next(
        (card["judge"]["slug"] for card in cards if (card.get("judge") or {}).get("slug")), ""
    )
    ranked = sorted(
        (c for c in candidates if c.get("aggregate_mean") is not None),
        key=lambda c: -c["aggregate_mean"],
    )
    shortlist = ranked[:12]

    ledger_rows = "".join(
        f'<tr><td>{esc(f["filter"])}</td><td class="num">-{f["rows_removed"]}</td>'
        f'<td class="num">{f["rows_after"]}</td></tr>'
        for f in snap["filter_ledger"]
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
        shortlist_rows.append(
            f'<tr{" class=inuse" if in_use else ""}><td class="num">{rank}</td>'
            f'<td><code>{esc(cand["slug"])}</code> {role}</td>'
            f'<td class="num">{cand["aggregate_mean"]:.1f}</td>'
            f'<td><span class="tag {count_cls}">{bench_count} bench{"es" if bench_count != 1 else ""}</span></td>'
            f'<td>{esc(cand["lineage"]["base_family"])}</td>'
            f'<td class="num">${blended_request_cost(cand["pricing"]):.4f}</td></tr>'
        )

    tp_count = sum(
        1
        for c in candidates
        if any(e.get("trust") == "third-party" for e in c.get("coding_evidence") or [])
    )
    none_count = sum(1 for c in candidates if not (c.get("coding_evidence") or []))

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
  .sub{{color:var(--muted);margin:0 0 14px;font-size:14px}}
  .card{{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px 22px;margin-bottom:14px}}
  .tag{{display:inline-block;border-radius:6px;padding:2px 9px;font-size:12px;font-weight:600}}
  .tag.pass{{background:var(--green-soft);color:var(--green)}}
  .tag.fail{{background:var(--red-soft);color:var(--red)}}
  .tag.warn{{background:var(--amber-soft);color:var(--amber)}}
  .tag.info{{background:var(--blue-soft);color:var(--blue)}}
  .tag.dir{{background:var(--violet-soft);color:var(--violet)}}
  table{{width:100%;border-collapse:collapse;font-size:13.5px}}
  th{{text-align:left;color:var(--muted);font-weight:600;padding:7px 10px;border-bottom:2px solid var(--line);white-space:nowrap}}
  td{{padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}}
  tr:last-child td{{border-bottom:none}}
  td.num,th.num{{text-align:right;font-variant-numeric:tabular-nums}}
  tr.inuse{{background:#f0f6ff}}
  code{{font-size:12.5px;background:#eef1f6;border-radius:4px;padding:1px 5px}}
  .mut{{color:var(--muted)}}
  .cov{{text-align:right;font-variant-numeric:tabular-nums;font-size:12.5px}}
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
  .hyp .hyphead{{display:flex;align-items:center;gap:10px;margin-bottom:8px}}
  .hyp h3{{margin:0;font-size:16px}}
  .mchips{{display:flex;gap:8px;flex-wrap:wrap}}
  .mchip{{border:2px solid;border-radius:8px;padding:4px 10px;font-size:13px;background:#fff}}
  .mchip small{{color:var(--muted)}}
  table.pk td{{border-bottom:none;padding:3px 8px;font-size:13px}}
  td.pklab{{color:var(--muted);white-space:nowrap;width:70px;font-weight:600}}
  .readme li{{margin:6px 0}}
</style>
</head>
<body><div class="wrap">

<header class="hero">
  <h1>Phase A Briefing - Clean-Room Catalog, Shortlist &amp; Hypotheses</h1>
  <p>What the 2026-07-07 snapshot says, how the shortlist was ranked, and what the five
     hypothesis cards commit us to test. Everything here traces to committed artifacts.</p>
  <div class="chips">
    <span class="chip">API rows <b>{snap["total_rows_in_api"]}</b></span>
    <span class="chip">candidates <b>{len(candidates)}</b></span>
    <span class="chip">shortlist <b>{len(shortlist)}</b></span>
    <span class="chip">hypotheses <b>{len(cards)}</b></span>
    <span class="chip">spend <b>$0</b></span>
    <span class="chip">retrieved <b>{esc(snap["retrieved_at"])}</b></span>
  </div>
</header>

<h2><span class="num">1</span>The funnel: 343 API rows &rarr; 34 candidates</h2>
<p class="sub">Mechanical filters only - no score-based selection happened at this stage.
Source: <code>docs/fusion/catalog-snapshot-2026-07-07.yaml</code> filter ledger.</p>
<div class="card">
<table><thead><tr><th>Filter</th><th class="num">Rows removed</th><th class="num">Rows after</th></tr></thead>
<tbody>{ledger_rows}</tbody></table>
</div>

<h2><span class="num">2</span>Value map: what you pay vs what leaderboards say</h2>
<p class="sub">Each dot is a candidate with at least one usable third-party score. Black-ring dots
sit on a hypothesis panel; the amber-ring dot is the judge. Up and left is better.
Hover for exact numbers.</p>
<div class="card">{scatter_svg(candidates, panel_slugs, judge_slug)}</div>

<h2><span class="num">3</span>Evidence coverage: how much do we actually know?</h2>
<p class="sub">The single most important caveat in Phase A. {tp_count} of {len(candidates)} candidates
have any third-party score; {none_count} have none at all. Ranks built on one benchmark are weaker
than ranks built on three - see the recorded limitation in the snapshot prose.</p>
<div class="card" style="max-height:520px;overflow-y:auto">{coverage_matrix(candidates)}</div>
<div class="legend">
  <span class="cov tp">third-party</span>
  <span class="cov vendor">vendor-claimed (excluded from ranking)</span>
  <span class="cov sat">saturated (excluded from ranking)</span>
  <span class="cov none" style="background:#eef1f6">- no data</span>
</div>

<h2><span class="num">4</span>The shortlist: 12 models by simple unweighted mean</h2>
<p class="sub">Highlighted rows are used by a hypothesis (panel member or judge). The "benches"
column shows how many unsaturated third-party benchmarks back each mean - treat 1-bench ranks
with caution.</p>
<div class="card">
<table><thead><tr><th class="num">#</th><th>Model</th><th class="num">Mean</th><th>Evidence</th>
<th>Family</th><th class="num">$/request</th></tr></thead>
<tbody>{"".join(shortlist_rows)}</tbody></table>
</div>

<h2><span class="num">5</span>The five bets: hypothesis cards at a glance</h2>
<p class="sub">Each card is a falsifiable commitment made before any run. Costs use the shared
model: 2k input + 8k output per member (20k output for 64k thinking budgets), judge 15k in + 4k out.
Frontier anchor (GPT-5.5-class) costs ~$0.25/request; the panel envelope is one third of that.</p>
{hypothesis_section(cards, slug_meta)}

<h2><span class="num">6</span>How to read all of this</h2>
<div class="card readme">
<ul>
<li><b>Nothing here is a result.</b> Phase A produces <i>hypotheses</i>, not measurements. The
shortlist mean is a shortlisting heuristic over incompatible public harnesses, not a ranking
we would defend. The first real numbers arrive in Phase C, on our own graded task manifest.</li>
<li><b>The question each hypothesis answers:</b> h1 is the honest default (top-3 by rank under
vetoes); h2 asks if style diversity beats rank; h3 asks if a cheap-first cascade wins on $/solve;
h4 asks if one strong model sampled 3x makes panels pointless (if it wins, we ship routing, not
fusion); h5 asks if paying for 64k thinking budgets is worth it.</li>
<li><b>What would change our minds:</b> every card carries a preregistered kill condition. The
plan treats "H4 wins, route don't fuse" as a fully acceptable shippable outcome.</li>
<li><b>Where to dig deeper:</b> machine-readable data in
<code>docs/fusion/catalog-snapshot-2026-07-07.yaml</code> (per-score provenance URLs), prose and
judgment calls in the companion <code>.md</code>, full card reasoning in
<code>labruns/2026-q3/hypotheses/</code>, pinned identities in
<code>python/fusionkit-lab/registry/2026-q3.yaml</code>.</li>
<li><b>Known weaknesses (recorded, not hidden):</b> ranks 1-2 rest on a single benchmark
(LiveCodeBench rolling) while lower ranks average in the much harder SWE-bench Pro; vendor-claimed
scores were excluded from ranking; 3 candidates have no public evidence at all. Phase C measures
all 12 shortlisted models on one harness, which supersedes this heuristic entirely.</li>
</ul>
</div>

<p class="sub" style="margin-top:30px">Generated from committed artifacts by
<code>analysis/phase-a-briefing-2026-07-07/scripts/build_briefing.py</code>. Regenerate after any
snapshot or card change.</p>

</div></body></html>
"""
    OUT.write_text(page, encoding="utf-8")
    print(f"wrote {OUT} ({len(page):,} bytes)")


if __name__ == "__main__":
    build()
