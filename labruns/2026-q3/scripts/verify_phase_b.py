#!/usr/bin/env python3
"""Verify Phase B artifacts and conclusions without API calls."""

from __future__ import annotations

import json
import re
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[3]
CARDS_DIR = REPO / "labruns/2026-q3/hypotheses"
LINEAGE = {
    "ds32": "deepseek-v3",
    "dsv4pro": "deepseek-v4",
    "nemotron3s": "nemotron-3-super",
    "glm52": "glm-5",
    "ds32_64k": "deepseek-v3",
    "kimi26_64k": "kimi-k2",
    "nemotron3s_64k": "nemotron-3-super",
}
READY = {"h1-backbone", "h2-style-diverse", "h5-thinking-heavy"}


def load_card(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    match = re.match(r"---\n(.*?)\n---", text, re.S)
    if not match:
        raise ValueError(f"no front matter: {path}")
    return yaml.safe_load(match.group(1))


def check_config(path: Path) -> list[str]:
    errors: list[str] = []
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    ids = {e["id"] for e in doc["endpoints"]}
    panel = doc["panel_models"]
    judge, synth = doc["judge_model"], doc["synthesizer_model"]
    if judge not in panel:
        errors.append(f"{path}: judge_model {judge!r} not in panel_models")
    if synth not in panel:
        errors.append(f"{path}: synthesizer_model {synth!r} not in panel_models")
    if not all(m in ids for m in panel):
        errors.append(f"{path}: panel_models reference unknown endpoint ids")
    fams = [LINEAGE.get(m, m) for m in panel]
    if len(fams) != len(set(fams)):
        errors.append(f"{path}: lineage veto failed for {panel}")
    if doc.get("default_mode") != "panel":
        errors.append(f"{path}: expected default_mode panel")
    return errors


def main() -> None:
    errors: list[str] = []
    prereg = (REPO / "labruns/2026-q3/prereg-measurement.md").read_text(encoding="utf-8")
    smoke_doc = (REPO / "labruns/2026-q3/smoke-results.md").read_text(encoding="utf-8")
    smoke_script = REPO / "labruns/2026-q3/scripts/smoke_panels.py"
    gateway_script = REPO / "labruns/2026-q3/scripts/smoke_gateway.py"

    if "smoke_panels.py" not in prereg:
        errors.append("prereg-measurement.md missing smoke_panels.py reference")
    if "Phase B complete" not in smoke_doc:
        errors.append("smoke-results.md does not claim Phase B complete")
    if not smoke_script.is_file():
        errors.append("smoke_panels.py missing")
    if not gateway_script.is_file():
        errors.append("smoke_gateway.py missing")
    if "fusionkit-dev" not in smoke_doc:
        errors.append("smoke-results.md missing fusionkit-dev gateway path section")

    for card_path in sorted(CARDS_DIR.glob("*.md")):
        card = load_card(card_path)
        hid = card["hypothesis_id"]
        if hid in READY:
            if card.get("status") != "smoke_passed":
                errors.append(f"{hid}: expected smoke_passed, got {card.get('status')}")
            cfg_rel = card.get("fusionkit_config")
            if not cfg_rel:
                errors.append(f"{hid}: missing fusionkit_config")
                continue
            cfg_path = REPO / cfg_rel
            if not cfg_path.is_file():
                errors.append(f"{hid}: config missing at {cfg_rel}")
                continue
            judge = card.get("judge") or {}
            if not judge.get("is_panel_member"):
                errors.append(f"{hid}: judge must be panel member")
            if card.get("topology") != "panel":
                errors.append(f"{hid}: expected topology panel")
            errors.extend(check_config(cfg_path))
            if judge.get("endpoint_id") != card.get("synthesizer", {}).get("endpoint_id"):
                errors.append(f"{hid}: judge and synthesizer endpoint_id differ")
        elif hid == "h3-cheap-cascade":
            if card.get("status") != "out_of_scope":
                errors.append("h3: expected out_of_scope")
        elif hid == "h4-best-single-baseline" or card_path.name == "h4-self-moa.md":
            if card.get("status") != "baseline_metric":
                errors.append("h4: expected baseline_metric")

    if errors:
        print("PHASE B VERIFY: FAIL")
        for err in errors:
            print(f"  - {err}")
        raise SystemExit(1)

    print(json.dumps({"phase_b_verify": "pass", "ready_cards": sorted(READY)}, indent=2))


if __name__ == "__main__":
    main()
