"""Robust extraction of a runnable program from a model's response.

Mis-extraction silently mis-scores a benchmark (a working solution scored as a
failure because the fenced block was missed). This module handles the common
shapes - a ```python fenced block, a generic fenced block, prose followed by bare
code - and reports which method was used so anomalies (e.g. a fused answer passing
while a candidate "failed") can be audited rather than trusted blindly.
"""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel

ExtractionMethod = Literal[
    "fenced_python",
    "fenced_any",
    "heuristic_prose_strip",
    "raw",
    "empty",
]

_FENCED_PYTHON = re.compile(r"```(?:python|py)\s*\n(.*?)```", re.DOTALL | re.IGNORECASE)
_FENCED_ANY = re.compile(r"```[^\n`]*\n(.*?)```", re.DOTALL)
# Lines that plausibly begin a Python program when there is no fence.
_CODE_START = re.compile(r"^\s*(import |from |def |class |if __name__|#!|@)")


class ExtractedCode(BaseModel):
    code: str
    method: ExtractionMethod


def extract_code(text: str) -> ExtractedCode:
    if not text or not text.strip():
        return ExtractedCode(code="", method="empty")

    python_blocks = _FENCED_PYTHON.findall(text)
    if python_blocks:
        return ExtractedCode(code=max(python_blocks, key=len).strip(), method="fenced_python")

    any_blocks = _FENCED_ANY.findall(text)
    if any_blocks:
        return ExtractedCode(code=max(any_blocks, key=len).strip(), method="fenced_any")

    lines = text.splitlines()
    for index, line in enumerate(lines):
        if _CODE_START.match(line):
            code = "\n".join(lines[index:]).strip()
            return ExtractedCode(code=code, method="heuristic_prose_strip")

    return ExtractedCode(code=text.strip(), method="raw")


def extract_code_str(text: str) -> str:
    return extract_code(text).code


__all__ = ["ExtractedCode", "ExtractionMethod", "extract_code", "extract_code_str"]
