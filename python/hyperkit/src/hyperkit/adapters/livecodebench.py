"""LiveCodeBench (code_generation_lite) adapter -- Docker-free, kernel-parametrized.

Runs stdin/stdout competitive-programming instances against an opaque
OpenAI-compatible SUT endpoint and grades locally by executing the candidate
program in a hardened subprocess sandbox. No Docker, no external harness.

Harness-side kernels are cell coordinates via ``Cell.params``:

- ``n_samples`` (int, default 1): candidates sampled from the endpoint.
- ``temps`` (list[float], default [0.2]): per-sample temperatures (cycled).
- ``selection``: ``first`` (grade sample 0) | ``public-exec`` (pick the sample
  passing the most PUBLIC tests, grade on PRIVATE -- leakage-free) |
  ``public-exec-repair`` (public-exec + one failure-directed repair round when
  the winner still fails a public test).
- ``max_tokens`` (default 16384), ``test_timeout_s`` (default 8.0),
  ``model`` (override the target's served model id, e.g. a fusionkit
  passthrough endpoint id).

Problem data comes from a local store directory (``HYPERKIT_LCB_DIR``, default
``~/.cache/hyperkit/livecodebench``) with one ``<question_id>.json`` per
instance holding the raw dataset row fields; see
``analysis/hypergrid/build_lcb_store.py`` for the builder. The adapter is
SUT-agnostic and never imports fusionkit.
"""

from __future__ import annotations

import base64
import contextlib
import json
import os
import pickle
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zlib
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from hyperkit.core import registry
from hyperkit.core.manifests import TextManifest
from hyperkit.core.models import ResourceProfile, SUTTarget

try:  # POSIX only
    import resource as _resource
except ImportError:  # pragma: no cover - non-POSIX
    _resource = None

PROMPT_SUFFIX = (
    "\n\nWrite a complete Python 3 program that reads from standard input and writes the "
    "answer to standard output. Respond with ONLY a single Python code block."
)

REPAIR_TEMPLATE = (
    "Your previous program for this problem failed a sample test.\n\n"
    "Problem:\n{problem}\n\n"
    "Your program:\n```python\n{code}\n```\n\n"
    "Failing test:\nstdin:\n{stdin}\n\nexpected stdout:\n{expected}\n\n"
    "actual stdout:\n{actual}\n\nstderr:\n{stderr}\n\n"
    "Fix the program. Respond with ONLY a single corrected Python code block."
)

_FENCED_PYTHON = re.compile(r"```(?:python|py)\s*\n(.*?)```", re.DOTALL | re.IGNORECASE)
_FENCED_ANY = re.compile(r"```[^\n`]*\n(.*?)```", re.DOTALL)
_CODE_START = re.compile(r"^\s*(import |from |def |class |if __name__|#!|@)")

_ENV_ALLOWLIST = ("PATH", "LANG", "LC_ALL", "LC_CTYPE", "PYTHONHASHSEED")
_OUTPUT_LIMIT = 1 << 20
_CPU_SECONDS = 12
_MEMORY_BYTES = 1 << 30


def _store_dir() -> Path:
    return Path(
        os.environ.get(
            "HYPERKIT_LCB_DIR",
            str(Path.home() / ".cache" / "hyperkit" / "livecodebench"),
        )
    )


def extract_code(text: str) -> str:
    """Best-effort extraction of a runnable Python program from a response."""

    if not text or not text.strip():
        return ""
    python_blocks = _FENCED_PYTHON.findall(text)
    if python_blocks:
        return max(python_blocks, key=len).strip()
    any_blocks = _FENCED_ANY.findall(text)
    if any_blocks:
        return max(any_blocks, key=len).strip()
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if _CODE_START.match(line):
            return "\n".join(lines[index:]).strip()
    return text.strip()


def _normalize(output: str) -> str:
    return "\n".join(line.rstrip() for line in output.strip("\n").splitlines()).strip()


def decode_tests(row: dict[str, Any]) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    """Decode (public, private) stdin tests; private falls back to public."""

    public: list[dict[str, str]] = []
    with contextlib.suppress(KeyError, json.JSONDecodeError, TypeError):
        public.extend(json.loads(row["public_test_cases"]))
    private: list[dict[str, str]] = []
    raw_private = row.get("private_test_cases")
    if isinstance(raw_private, str) and raw_private:
        try:
            private.extend(json.loads(raw_private))
        except json.JSONDecodeError:
            with contextlib.suppress(Exception):  # best-effort compressed decode
                private.extend(
                    json.loads(
                        pickle.loads(zlib.decompress(base64.b64decode(raw_private.encode())))
                    )
                )
    public_stdin = [t for t in public if t.get("testtype") == "stdin"]
    private_stdin = [t for t in private if t.get("testtype") == "stdin"]
    return public_stdin, (private_stdin or public_stdin)


class _Sandbox:
    """Hardened local subprocess: scrubbed env, rlimits, throwaway tmpdir."""

    def _limits(self):  # pragma: no cover - runs in the forked child
        def set_limits() -> None:
            if _resource is None:
                return
            with contextlib.suppress(Exception):
                _resource.setrlimit(_resource.RLIMIT_CPU, (_CPU_SECONDS, _CPU_SECONDS))
            with contextlib.suppress(Exception):
                _resource.setrlimit(_resource.RLIMIT_FSIZE, (_OUTPUT_LIMIT, _OUTPUT_LIMIT))
            with contextlib.suppress(Exception):
                _resource.setrlimit(_resource.RLIMIT_AS, (_MEMORY_BYTES, _MEMORY_BYTES))

        return set_limits

    def run(self, code: str, stdin: str, *, timeout_s: float) -> dict[str, Any]:
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "sol.py").write_text(code, encoding="utf-8")
            env = {k: os.environ[k] for k in _ENV_ALLOWLIST if k in os.environ}
            env.setdefault("PATH", os.defpath)
            env["HOME"] = tmp
            env["TMPDIR"] = tmp
            try:
                completed = subprocess.run(
                    [sys.executable, "sol.py"],
                    cwd=tmp,
                    input=stdin.encode(),
                    capture_output=True,
                    env=env,
                    timeout=timeout_s,
                    preexec_fn=self._limits() if os.name == "posix" else None,
                    check=False,
                )
            except subprocess.TimeoutExpired:
                return {"ok": False, "stdout": "", "stderr": "", "timed_out": True}
            return {
                "ok": completed.returncode == 0,
                "stdout": completed.stdout.decode(errors="replace")[:_OUTPUT_LIMIT],
                "stderr": completed.stderr.decode(errors="replace")[:4096],
                "timed_out": False,
            }


def run_tests(
    sandbox: _Sandbox,
    code: str,
    tests: Sequence[dict[str, str]],
    *,
    timeout_s: float,
    stop_on_failure: bool = True,
) -> dict[str, Any]:
    """Execute code on tests. Returns passes, total, first failure detail."""

    if not code.strip() or not tests:
        return {"passed": 0, "total": len(tests), "all_passed": False, "failure": None}
    passed = 0
    failure: dict[str, Any] | None = None
    for test in tests:
        expected = test.get("output", "")
        result = sandbox.run(code, test.get("input", ""), timeout_s=timeout_s)
        ok = result["ok"] and _normalize(expected) == _normalize(result["stdout"])
        if ok:
            passed += 1
            continue
        if failure is None:
            failure = {
                "stdin": test.get("input", "")[:2000],
                "expected": expected[:2000],
                "actual": result["stdout"][:2000],
                "stderr": result["stderr"][:2000],
                "timed_out": result["timed_out"],
            }
        if stop_on_failure:
            break
    return {
        "passed": passed,
        "total": len(tests),
        "all_passed": passed == len(tests),
        "failure": failure,
    }


class _Client:
    """Minimal OpenAI-compatible chat client (stdlib only, retrying)."""

    def __init__(self, base_url: str, api_key: str | None):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    def complete(
        self,
        model: str,
        prompt: str,
        *,
        temperature: float,
        max_tokens: int,
        timeout_s: float = 900.0,
        attempts: int = 4,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": temperature,
            "max_tokens": max_tokens,
            # OpenRouter returns exact billed cost; other servers ignore this.
            "usage": {"include": True},
        }
        body = json.dumps(payload).encode()
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        url = f"{self.base_url}/chat/completions"
        last_error: Exception | None = None
        for attempt in range(attempts):
            request = urllib.request.Request(url, data=body, headers=headers)
            try:
                with urllib.request.urlopen(request, timeout=timeout_s) as response:
                    data = json.loads(response.read())
                choice = (data.get("choices") or [{}])[0]
                message = choice.get("message") or {}
                usage = data.get("usage") or {}
                return {
                    "text": message.get("content") or "",
                    "prompt_tokens": int(usage.get("prompt_tokens") or 0),
                    "completion_tokens": int(usage.get("completion_tokens") or 0),
                    "cost_usd": float(usage.get("cost") or 0.0),
                    "finish_reason": choice.get("finish_reason"),
                }
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as exc:
                last_error = exc
                retryable = True
                if isinstance(exc, urllib.error.HTTPError):
                    retryable = exc.code in (408, 409, 429, 500, 502, 503, 504)
                if not retryable or attempt == attempts - 1:
                    raise
                time.sleep(min(60.0, 2.0 * 2**attempt))
        raise RuntimeError(f"chat completion failed: {last_error}")


class LivecodebenchGrader:
    def grade(self, instance_id: str, raw_output: dict[str, Any]) -> dict[str, Any]:
        return {"resolved": bool(raw_output.get("resolved", False))}


class LivecodebenchAdapter:
    name = "livecodebench"
    version = "1"

    def manifest(self, ref: str) -> TextManifest:
        return TextManifest(ref)

    def resource_profile(self) -> ResourceProfile:
        return ResourceProfile(vcpu=2.0, memory_gb=2.0, needs_docker=False, wall_clock_s=3600)

    def grader(self) -> LivecodebenchGrader:
        return LivecodebenchGrader()

    def load_problem(self, instance_id: str) -> dict[str, Any]:
        path = _store_dir() / f"{instance_id}.json"
        if not path.exists():
            raise FileNotFoundError(
                f"LCB problem store missing {path}; run analysis/hypergrid/build_lcb_store.py"
            )
        return json.loads(path.read_text(encoding="utf-8"))

    def run_instance(
        self, instance_id: str, target: SUTTarget, workdir: Path, params: dict[str, Any]
    ) -> dict[str, Any]:
        problem = self.load_problem(instance_id)
        prompt = (problem.get("question_content") or "") + PROMPT_SUFFIX
        public_tests, private_tests = decode_tests(problem)

        n_samples = int(params.get("n_samples", 1))
        temps = [float(t) for t in params.get("temps", [0.2])] or [0.2]
        selection = str(params.get("selection", "first"))
        max_tokens = int(params.get("max_tokens", 16384))
        timeout_s = float(params.get("test_timeout_s", 8.0))
        model = str(params.get("model", target.model))

        client = _Client(target.base_url, _resolve_api_key(target.base_url, params))
        sandbox = _Sandbox()

        samples: list[dict[str, Any]] = []
        for index in range(n_samples):
            temperature = temps[index % len(temps)]
            completion = client.complete(
                model, prompt, temperature=temperature, max_tokens=max_tokens
            )
            code = extract_code(completion["text"])
            public = run_tests(
                sandbox, code, public_tests, timeout_s=timeout_s, stop_on_failure=False
            )
            samples.append(
                {
                    "index": index,
                    "temperature": temperature,
                    "code": code,
                    "finish_reason": completion["finish_reason"],
                    "prompt_tokens": completion["prompt_tokens"],
                    "completion_tokens": completion["completion_tokens"],
                    "cost_usd": completion["cost_usd"],
                    "public_passed": public["passed"],
                    "public_total": public["total"],
                    "public_all": public["all_passed"],
                    "public_failure": public["failure"],
                }
            )

        if selection == "first":
            selected = 0
        elif selection in ("public-exec", "public-exec-repair"):
            selected = max(
                range(len(samples)),
                key=lambda i: (samples[i]["public_passed"], -i),
            )
        else:
            raise ValueError(f"unknown selection policy: {selection}")

        repair_used = False
        winner = samples[selected]
        if (
            selection == "public-exec-repair"
            and not winner["public_all"]
            and winner["public_failure"] is not None
        ):
            repair_used = True
            failure = winner["public_failure"]
            repair_prompt = REPAIR_TEMPLATE.format(
                problem=problem.get("question_content") or "",
                code=winner["code"],
                stdin=failure["stdin"],
                expected=failure["expected"],
                actual=failure["actual"],
                stderr=failure["stderr"],
            )
            completion = client.complete(
                model, repair_prompt, temperature=temps[0], max_tokens=max_tokens
            )
            repaired_code = extract_code(completion["text"])
            repaired_public = run_tests(
                sandbox, repaired_code, public_tests, timeout_s=timeout_s, stop_on_failure=False
            )
            repaired = {
                "index": len(samples),
                "temperature": temps[0],
                "code": repaired_code,
                "finish_reason": completion["finish_reason"],
                "prompt_tokens": completion["prompt_tokens"],
                "completion_tokens": completion["completion_tokens"],
                "cost_usd": completion["cost_usd"],
                "public_passed": repaired_public["passed"],
                "public_total": repaired_public["total"],
                "public_all": repaired_public["all_passed"],
                "public_failure": repaired_public["failure"],
                "repair_of": selected,
            }
            samples.append(repaired)
            if repaired["public_passed"] > winner["public_passed"]:
                selected = repaired["index"]

        # Grade every candidate on private tests (selected one decides the
        # shard; the rest provide oracle/regret diagnostics at zero API cost).
        for sample in samples:
            private = run_tests(sandbox, sample["code"], private_tests, timeout_s=timeout_s)
            sample["private_passed_all"] = private["all_passed"]
            sample["private_passed"] = private["passed"]
            sample["private_total"] = private["total"]

        resolved = bool(samples[selected]["private_passed_all"])
        total_cost = sum(float(s["cost_usd"]) for s in samples)
        total_tokens = sum(int(s["prompt_tokens"]) + int(s["completion_tokens"]) for s in samples)
        # Drop code bodies from the checkpoint except the selected one.
        slim = [
            {**{k: v for k, v in s.items() if k != "code"}, "public_failure": None}
            for s in samples
        ]
        return {
            "resolved": resolved,
            "selected_index": selected,
            "selection": selection,
            "repair_used": repair_used,
            "oracle_private": any(s["private_passed_all"] for s in samples),
            "samples": slim,
            "selected_code": samples[selected]["code"],
            "cost_usd": total_cost,
            "tokens": total_tokens,
            "difficulty": problem.get("difficulty"),
            "contest_date": problem.get("contest_date"),
        }

    def parse_report(self, report: dict[str, Any], instances: Sequence[str]) -> dict[str, bool]:
        outcomes = report.get("outcomes", {})
        return {inst: bool(outcomes.get(inst, False)) for inst in instances}


def _resolve_api_key(base_url: str, params: dict[str, Any]) -> str | None:
    env_name = params.get("api_key_env")
    if env_name:
        return os.environ.get(str(env_name))
    if "openrouter" in base_url:
        return os.environ.get("OPENROUTER_API_KEY")
    if "127.0.0.1" in base_url or "localhost" in base_url:
        return os.environ.get("FUSIONKIT_LOCAL_API_KEY", "local")
    return None


registry.register_benchmark(LivecodebenchAdapter())
