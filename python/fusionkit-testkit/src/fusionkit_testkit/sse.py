"""SSE observation helpers.

Shared parsing for the OpenAI-style ``data:`` streams the FusionKit server
emits, so tests assert on structured frames instead of re-implementing SSE
splitting inline (the pattern this testkit replaces).
"""

from __future__ import annotations

import json
from typing import Any


def parse_sse(body: str) -> list[dict[str, Any]]:
    """All JSON ``data:`` payloads of an SSE body, in order (``[DONE]`` dropped)."""
    frames: list[dict[str, Any]] = []
    for block in body.split("\n\n"):
        data_lines = [
            line[len("data:") :].strip() for line in block.split("\n") if line.startswith("data:")
        ]
        if not data_lines:
            continue
        payload = "\n".join(data_lines)
        if payload == "[DONE]":
            continue
        frames.append(json.loads(payload))
    return frames


def sse_text(frames: list[dict[str, Any]]) -> str:
    """Concatenated ``delta.content`` of OpenAI chat-completion chunks."""
    text: list[str] = []
    for frame in frames:
        choices = frame.get("choices") or []
        if choices and "error" not in frame:
            text.append(choices[0].get("delta", {}).get("content") or "")
    return "".join(text)


def sse_reasoning(frames: list[dict[str, Any]]) -> str:
    """Concatenated out-of-band reasoning deltas (``reasoning_content`` + ``reasoning``)."""
    text: list[str] = []
    for frame in frames:
        choices = frame.get("choices") or []
        if not choices:
            continue
        delta = choices[0].get("delta", {})
        text.append(delta.get("reasoning_content") or "")
        text.append(delta.get("reasoning") or "")
    return "".join(text)


def sse_done(body: str) -> bool:
    return "data: [DONE]" in body
