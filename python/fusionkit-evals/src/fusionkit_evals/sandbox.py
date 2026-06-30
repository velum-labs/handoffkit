"""Pluggable sandbox for executing untrusted model-generated code.

Benchmark solutions are written by LLMs and must be treated as hostile: they must
not see provider API keys, reach the network, exhaust memory/CPU, or write outside
a throwaway directory. This module provides a small ``Sandbox`` protocol with two
backends:

- :class:`LocalSandbox` (default): a hardened subprocess - environment scrubbed to
  a minimal allowlist (no API keys), temp ``HOME``/cwd, POSIX resource limits
  (CPU, address space, file size), and an output-size cap enforced by the OS via
  ``RLIMIT_FSIZE`` (so a runaway ``print`` can't OOM the harness).
- :class:`DockerSandbox` (full/CI): a ``--network none`` container with memory,
  CPU, and pids limits and a read-only mount.

Backends are selected with :func:`build_sandbox` (env ``BENCH_SANDBOX``).
"""

from __future__ import annotations

import contextlib
import os
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Callable, Sequence
from pathlib import Path
from types import ModuleType
from typing import Protocol

from pydantic import BaseModel, Field

try:  # POSIX only; absent on Windows
    import resource as _resource
except ImportError:  # pragma: no cover - non-POSIX
    _resource = None
resource: ModuleType | None = _resource

# Minimal environment the child may inherit. Critically excludes *_API_KEY and any
# other secret-bearing variables present in the parent process.
DEFAULT_ENV_ALLOWLIST: tuple[str, ...] = (
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "PYTHONHASHSEED",
)


class SandboxResult(BaseModel):
    returncode: int | None
    stdout: str = ""
    stderr: str = ""
    timed_out: bool = False
    output_truncated: bool = False
    backend: str = "local"

    @property
    def ok(self) -> bool:
        return self.returncode == 0 and not self.timed_out


class SandboxUnavailable(RuntimeError):
    """The requested sandbox backend is not available on this host."""


class Sandbox(Protocol):
    backend: str

    def run(self, code: str, stdin: str, *, timeout_s: float) -> SandboxResult: ...


class LocalSandbox:
    backend = "local"

    def __init__(
        self,
        *,
        cpu_seconds: int = 10,
        memory_bytes: int | None = 1 << 30,
        output_limit_bytes: int = 1 << 20,
        env_allowlist: Sequence[str] = DEFAULT_ENV_ALLOWLIST,
        python_executable: str | None = None,
    ) -> None:
        self.cpu_seconds = cpu_seconds
        self.memory_bytes = memory_bytes
        self.output_limit_bytes = output_limit_bytes
        self.env_allowlist = tuple(env_allowlist)
        self.python_executable = python_executable or sys.executable

    def scrubbed_env(self, home: str) -> dict[str, str]:
        env = {key: os.environ[key] for key in self.env_allowlist if key in os.environ}
        env.setdefault("PATH", os.defpath)
        env["HOME"] = home
        env["TMPDIR"] = home
        return env

    def _limit_setter(self) -> Callable[[], None]:
        cpu_seconds = self.cpu_seconds
        memory_bytes = self.memory_bytes
        output_limit = self.output_limit_bytes

        def set_limits() -> None:  # runs in the child between fork and exec
            if resource is None:  # pragma: no cover - non-POSIX
                return
            with contextlib.suppress(Exception):
                resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds))
            with contextlib.suppress(Exception):
                resource.setrlimit(resource.RLIMIT_FSIZE, (output_limit, output_limit))
            if memory_bytes is not None:
                with contextlib.suppress(Exception):
                    resource.setrlimit(resource.RLIMIT_AS, (memory_bytes, memory_bytes))

        return set_limits

    def run(self, code: str, stdin: str, *, timeout_s: float) -> SandboxResult:
        with tempfile.TemporaryDirectory() as tmp:
            solution = Path(tmp) / "sol.py"
            solution.write_text(code, encoding="utf-8")
            out_path = Path(tmp) / "stdout.bin"
            err_path = Path(tmp) / "stderr.bin"
            timed_out = False
            returncode: int | None = None
            with out_path.open("wb") as out_f, err_path.open("wb") as err_f:
                try:
                    completed = subprocess.run(
                        [self.python_executable, "sol.py"],
                        cwd=tmp,
                        input=stdin.encode(),
                        stdout=out_f,
                        stderr=err_f,
                        env=self.scrubbed_env(tmp),
                        timeout=timeout_s,
                        preexec_fn=self._limit_setter() if os.name == "posix" else None,
                        check=False,
                    )
                    returncode = completed.returncode
                except subprocess.TimeoutExpired:
                    timed_out = True
            stdout, truncated = _read_capped(out_path, self.output_limit_bytes)
            stderr, _ = _read_capped(err_path, 64 * 1024)
            return SandboxResult(
                returncode=returncode,
                stdout=stdout,
                stderr=stderr,
                timed_out=timed_out,
                output_truncated=truncated,
                backend=self.backend,
            )


class DockerSandbox:
    backend = "docker"

    def __init__(
        self,
        *,
        image: str = "python:3.12-slim",
        cpus: float = 1.0,
        memory: str = "1g",
        pids_limit: int = 128,
        docker_bin: str = "docker",
    ) -> None:
        self.image = image
        self.cpus = cpus
        self.memory = memory
        self.pids_limit = pids_limit
        self.docker_bin = docker_bin

    def docker_command(self, work_dir: str) -> list[str]:
        return [
            self.docker_bin,
            "run",
            "--rm",
            "--interactive",
            "--network",
            "none",
            "--cpus",
            str(self.cpus),
            "--memory",
            self.memory,
            "--pids-limit",
            str(self.pids_limit),
            "--read-only",
            "--tmpfs",
            "/tmp",
            "--volume",
            f"{work_dir}:/work:ro",
            "--workdir",
            "/work",
            self.image,
            "python",
            "sol.py",
        ]

    def run(self, code: str, stdin: str, *, timeout_s: float) -> SandboxResult:
        if shutil.which(self.docker_bin) is None:
            raise SandboxUnavailable(f"{self.docker_bin} not found on PATH")
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "sol.py").write_text(code, encoding="utf-8")
            try:
                completed = subprocess.run(
                    self.docker_command(tmp),
                    input=stdin.encode(),
                    capture_output=True,
                    timeout=timeout_s,
                    check=False,
                )
            except subprocess.TimeoutExpired:
                return SandboxResult(returncode=None, timed_out=True, backend=self.backend)
            return SandboxResult(
                returncode=completed.returncode,
                stdout=completed.stdout.decode(errors="replace"),
                stderr=completed.stderr.decode(errors="replace"),
                backend=self.backend,
            )


class SandboxConfig(BaseModel):
    backend: str = "local"
    cpu_seconds: int = 10
    memory_bytes: int | None = 1 << 30
    output_limit_bytes: int = 1 << 20
    docker_image: str = "python:3.12-slim"
    extra_env_allowlist: list[str] = Field(default_factory=list)


def build_sandbox(config: SandboxConfig | None = None) -> Sandbox:
    resolved = config or SandboxConfig(backend=os.environ.get("BENCH_SANDBOX", "local"))
    if resolved.backend == "local":
        return LocalSandbox(
            cpu_seconds=resolved.cpu_seconds,
            memory_bytes=resolved.memory_bytes,
            output_limit_bytes=resolved.output_limit_bytes,
            env_allowlist=(*DEFAULT_ENV_ALLOWLIST, *resolved.extra_env_allowlist),
        )
    if resolved.backend == "docker":
        return DockerSandbox(
            image=resolved.docker_image,
            memory=_bytes_to_docker(resolved.memory_bytes),
        )
    raise SandboxUnavailable(f"unknown sandbox backend: {resolved.backend}")


def _read_capped(path: Path, limit: int) -> tuple[str, bool]:
    if not path.exists():
        return "", False
    size = path.stat().st_size
    with path.open("rb") as handle:
        data = handle.read(limit)
    return data.decode(errors="replace"), size > limit


def _bytes_to_docker(memory_bytes: int | None) -> str:
    if memory_bytes is None:
        return "1g"
    return f"{max(1, memory_bytes // (1 << 20))}m"


__all__ = [
    "DEFAULT_ENV_ALLOWLIST",
    "DockerSandbox",
    "LocalSandbox",
    "Sandbox",
    "SandboxConfig",
    "SandboxResult",
    "SandboxUnavailable",
    "build_sandbox",
]
