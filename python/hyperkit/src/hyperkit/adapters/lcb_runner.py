"""Revision-pinned LiveCodeBench stdio execution semantics.

This is copied into the isolated grading directory and executed with only the
standard library. The behavior intentionally follows LiveCodeBench
``testing_util.py`` at commit 28fef95ea8c9f7a547c8329f2cd3d32b92c1fa24.
"""

from __future__ import annotations

import ast
import faulthandler
import json
import signal
import sys
import time
from contextlib import AbstractContextManager
from io import StringIO
from pathlib import Path
from types import ModuleType
from typing import Any
from unittest.mock import mock_open, patch

IMPORT_STRING = """from string import *
from re import *
from datetime import *
from collections import *
from heapq import *
from bisect import *
from copy import *
from math import *
from random import *
from statistics import *
from itertools import *
from functools import *
from operator import *
from io import *
from sys import *
from json import *
from builtins import *
from typing import *
import string
import re
import datetime
import collections
import heapq
import bisect
import copy
import math
import random
import statistics
import itertools
import functools
import operator
import io
import sys
import json
sys.setrecursionlimit(50000)
"""


class TimeoutException(Exception):
    pass


def _timeout_handler(_signum: int, _frame: object) -> None:
    raise TimeoutException


class Capturing(AbstractContextManager[list[str]]):
    def __init__(self) -> None:
        self.values: list[str] = []
        self._stdout: Any = None
        self._stringio: StringIO | None = None

    def __enter__(self) -> list[str]:
        self._stdout = sys.stdout
        self._stringio = StringIO()
        sys.stdout = self._stringio
        return self.values

    def __exit__(self, *_args: object) -> None:
        assert self._stringio is not None
        self.values.append(self._stringio.getvalue())
        sys.stdout = self._stdout


class MockStdinWithBuffer:
    def __init__(self, inputs: str):
        self.inputs = inputs
        self._stringio = StringIO(inputs)
        self.buffer = MockBuffer(inputs)

    def read(self, *_args: object) -> str:
        return self.inputs

    def readline(self, *args: object) -> str:
        return self._stringio.readline(*args)

    def readlines(self, *_args: object) -> list[str]:
        return self.inputs.split("\n")

    def __getattr__(self, name: str) -> Any:
        return getattr(self._stringio, name)


class MockBuffer:
    def __init__(self, inputs: str):
        self.inputs = inputs.encode()

    def read(self, *_args: object) -> bytes:
        return self.inputs

    def readline(self, *_args: object) -> bytes:
        return self.inputs.split(b"\n")[0] + b"\n"


def clean_if_name(code: str) -> str:
    try:
        tree = ast.parse(code)
        last_block = tree.body[-1]
        if isinstance(last_block, ast.If):
            if ast.unparse(last_block.test).strip() == "__name__ == '__main__'":
                return (
                    ast.unparse(tree.body[:-1])
                    + "\n"
                    + ast.unparse(last_block.body)
                )
    except Exception:
        pass
    return code


def make_function(code: str) -> str:
    try:
        imports: list[ast.stmt] = []
        body: list[ast.stmt] = []
        tree = ast.parse(code)
        for statement in tree.body:
            if isinstance(statement, (ast.Import, ast.ImportFrom)):
                imports.append(statement)
            else:
                body.append(statement)
        function = ast.FunctionDef(
            name="wrapped_function",
            args=ast.arguments(
                posonlyargs=[],
                args=[],
                kwonlyargs=[],
                kw_defaults=[],
                defaults=[],
            ),
            body=body,
            decorator_list=[],
            lineno=-1,
        )
        return (
            IMPORT_STRING
            + "\n"
            + ast.unparse(imports)
            + "\n"
            + ast.unparse(function)
        )
    except Exception:
        return code


def _compile(code: str, timeout_s: int) -> Any:
    signal.alarm(timeout_s)
    try:
        module = ModuleType("tmp_sol", "")
        exec(code, module.__dict__)
        return module
    finally:
        signal.alarm(0)


def _call(method: Any, inputs: str) -> None:
    input_lines = iter(inputs.split("\n"))
    mock_stdin = MockStdinWithBuffer(inputs)

    @patch("builtins.open", mock_open(read_data=inputs))
    @patch("sys.stdin", mock_stdin)
    @patch("sys.stdin.readline", lambda *_args: next(input_lines))
    @patch("sys.stdin.readlines", lambda *_args: inputs.split("\n"))
    @patch("sys.stdin.read", lambda *_args: inputs)
    def invoke(target: Any) -> None:
        try:
            target()
        except SystemExit:
            pass

    invoke(method)


def execute_suite(
    code: str,
    tests: list[dict[str, str]],
    *,
    timeout_s: int,
    stop_on_failure: bool,
) -> dict[str, Any]:
    signal.signal(signal.SIGALRM, _timeout_handler)
    transformed = make_function(clean_if_name(code))
    try:
        module = _compile(transformed, timeout_s)
        method = getattr(module, "wrapped_function")
    except Exception as exc:
        return {
            "compile_error": repr(exc),
            "results": [],
        }

    results: list[dict[str, Any]] = []
    for test in tests:
        started = time.monotonic()
        signal.alarm(timeout_s)
        faulthandler.enable()
        captured: list[str] = []
        error: str | None = None
        timed_out = False
        try:
            with Capturing() as captured:
                _call(method, test["input"])
        except TimeoutException as exc:
            timed_out = True
            error = repr(exc)
        except Exception as exc:
            error = repr(exc)
        finally:
            signal.alarm(0)
            faulthandler.disable()
        results.append(
            {
                "stdout": captured[0] if captured else "",
                "stderr": error or "",
                "timed_out": timed_out,
                "returncode": 0 if error is None else 1,
                "duration_s": time.monotonic() - started,
            }
        )
        if error is not None and stop_on_failure:
            break
    return {"compile_error": None, "results": results}


def main() -> int:
    code_path = Path(sys.argv[1])
    tests_path = Path(sys.argv[2])
    result_path = Path(sys.argv[3])
    timeout_s = int(sys.argv[4])
    stop_on_failure = sys.argv[5] == "1"
    tests = json.loads(tests_path.read_text())
    result = execute_suite(
        code_path.read_text(),
        tests,
        timeout_s=timeout_s,
        stop_on_failure=stop_on_failure,
    )
    result_path.write_text(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
