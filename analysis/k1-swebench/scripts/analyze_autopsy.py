"""Reconstruct per-step fusion decisions from the logging proxy's capture.

Reads provider_calls.jsonl (one record per OpenRouter call: request +
response + latency) and groups calls into fusion steps: N member fanout
calls, one judge call, one synthesizer call. For each step it extracts each
member's proposed tool-call batch, the judge's parsed verdict, and the
committed batch, then reports: which member was adopted, whether members
actually disagreed, and the judge's cited reasoning.

Usage: python analyze_autopsy.py /tmp/autopsy/provider_calls.jsonl [out.json]
"""

from __future__ import annotations

import json
import sys
from typing import Any

# With harness_prompt_passthrough (the default), the harness's own system
# prompt is the base for every role; the fusion framing is APPENDED. So the
# roles are distinguished by tools presence + appended markers:
#   member: tools present, plain harness system
#   judge:  no tools, system ends with the step-judge contract
#   synth:  tools present, system embeds the judge's analysis JSON
JUDGE_MARKER = "compare candidate NEXT-STEP proposals"
SYNTH_MARKER = '"best_trajectory"'


def classify(record: dict) -> str:
    req = record.get("request") or {}
    msgs = req.get("messages") or []
    system = (msgs[0].get("content") or "") if msgs else ""
    if isinstance(system, list):
        system = " ".join(str(part) for part in system)
    has_tools = bool(req.get("tools"))
    if not has_tools and JUDGE_MARKER in system:
        return "judge"
    if has_tools and SYNTH_MARKER in system:
        return "synth"
    if has_tools:
        return "member"
    return "other"


def response_step(record: dict) -> dict[str, Any]:
    resp = record.get("response") or {}
    choices = resp.get("choices") or [{}]
    message = choices[0].get("message") or {}
    calls = [
        {"name": (c.get("function") or {}).get("name"), "arguments": (c.get("function") or {}).get("arguments")}
        for c in (message.get("tool_calls") or [])
    ]
    return {
        "model": (record.get("request") or {}).get("model"),
        "content": (message.get("content") or "")[:4000],
        "tool_calls": calls,
        "latency_s": record.get("latency_s"),
    }


def batch_fingerprint(step: dict[str, Any]) -> str:
    """Semantic batch identity: parsed arguments, whitespace-insensitive."""
    normalized = []
    for call in step["tool_calls"]:
        args = call["arguments"]
        try:
            parsed = json.loads(args)
            if isinstance(parsed, dict) and isinstance(parsed.get("command"), str):
                parsed["command"] = " ".join(parsed["command"].split())
            normalized.append(json.dumps(parsed, sort_keys=True))
        except Exception:
            normalized.append(str(args))
    return json.dumps(normalized)


def instance_key(record: dict) -> str:
    """Stable per-task key: the first user message (the PR description)."""
    msgs = (record.get("request") or {}).get("messages") or []
    for m in msgs:
        if m.get("role") == "user":
            content = m.get("content")
            text = content if isinstance(content, str) else json.dumps(content)
            # Judge requests wrap the same task text in "Original request:".
            text = text.removeprefix("Original request:").lstrip()
            return text[:300]
    return "?"


def main() -> int:
    path = sys.argv[1]
    with open(path, encoding="utf-8") as f:
        records = sorted((json.loads(line) for line in f), key=lambda r: r["ts"])

    # Parallel workers interleave instances; within one instance the engine
    # is sequential, so reconstruct per instance key.
    by_instance: dict[str, list[dict]] = {}
    for record in records:
        by_instance.setdefault(instance_key(record), []).append(record)

    steps: list[dict[str, Any]] = []
    for _key, group in by_instance.items():
        steps.extend(reconstruct(group))

    report(steps)
    if len(sys.argv) > 2:
        with open(sys.argv[2], "w", encoding="utf-8") as f:
            json.dump(steps, f, indent=1)
        print("wrote", sys.argv[2])
    return 0


def reconstruct(records: list[dict]) -> list[dict[str, Any]]:
    steps: list[dict[str, Any]] = []
    pending_members: list[dict[str, Any]] = []
    pending_judge: dict[str, Any] | None = None
    for record in records:
        kind = classify(record)
        if kind == "member":
            pending_members.append(record)
        elif kind == "judge":
            pending_judge = record
        elif kind == "synth":
            members = [response_step(r) for r in pending_members[-2:]]
            judge_raw = ((record and pending_judge and (pending_judge.get("response") or {}).get("choices") or [{}])[0].get("message") or {}).get("content") or ""
            verdict: dict[str, Any] = {}
            try:
                cleaned = judge_raw.strip()
                if cleaned.startswith("```"):
                    cleaned = cleaned.split("\n", 1)[1].rsplit("```", 1)[0]
                verdict = json.loads(cleaned)
            except Exception:
                verdict = {"_unparsed": judge_raw[:500]}
            committed = response_step(record)
            n_msgs = len(((pending_members[-1].get("request") or {}).get("messages")) or []) if pending_members else 0
            adopted = None
            for member in members:
                if member["tool_calls"] and batch_fingerprint(member) == batch_fingerprint(committed):
                    adopted = member["model"]
            proposals_differ = (
                len(members) == 2 and batch_fingerprint(members[0]) != batch_fingerprint(members[1])
            )
            steps.append(
                {
                    "conversation_len": n_msgs,
                    "members": members,
                    "judge_best": verdict.get("best_trajectory"),
                    "judge_likely_errors": verdict.get("likely_errors"),
                    "judge_contradictions": verdict.get("contradictions"),
                    "committed": committed,
                    "adopted_member_verbatim": adopted,
                    "proposals_differ": proposals_differ,
                }
            )
            pending_members = []
            pending_judge = None
    return steps


def report(steps: list[dict[str, Any]]) -> None:
    print(f"steps reconstructed: {len(steps)}")
    differ = [s for s in steps if s["proposals_differ"]]
    print(f"steps where members disagreed: {len(differ)}")
    picks: dict[str, int] = {}
    for s in steps:
        best = s.get("judge_best") or "null"
        key = "terminus" if "terminus" in str(best) else ("qwen3" if "qwen3" in str(best) else str(best)[:20])
        picks[key] = picks.get(key, 0) + 1
    print("judge picks:", picks)
    verbatim = sum(1 for s in steps if s["adopted_member_verbatim"])
    print(f"committed batches matching a member verbatim: {verbatim}/{len(steps)}")
    named_differ = [s for s in steps if s.get("judge_best") and s["proposals_differ"]]
    follow = sum(
        1
        for s in named_differ
        if s["adopted_member_verbatim"]
        and (("terminus" in str(s["judge_best"])) == ("terminus" in s["adopted_member_verbatim"]))
    )
    print(f"contested steps (named pick + differing proposals): {len(named_differ)}; verbatim-followed: {follow}")


if __name__ == "__main__":
    sys.exit(main())
