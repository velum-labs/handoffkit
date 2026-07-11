"""Real-engine process harness.

Runs the actual ``fusionkit serve`` CLI as a child process — the same
entrypoint the Node CLI spawns in production — against a caller-provided
:class:`fusionkit_core.config.FusionConfig` (typically pointing every endpoint
at a :class:`~fusionkit_testkit.server.ProviderSimulator`). This is the
process-level test seam: it exercises config discovery/loading, uvicorn
startup, tracing setup, and the full HTTP surface exactly as shipped, instead
of an in-process ``create_app`` shortcut.

The harness is observable by construction: engine stdout/stderr are captured
and exposed via :attr:`EngineProcess.log`, and startup failures raise with the
captured log attached so a broken engine explains itself.
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from types import TracebackType
from typing import IO

import yaml
from fusionkit_core.config import FusionConfig

_STARTUP_TIMEOUT_S = 60.0


def free_port(host: str = "127.0.0.1") -> int:
    """Pick a currently free TCP port (standard bind-and-release probe)."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        return sock.getsockname()[1]


def _engine_argv() -> list[str]:
    """How to invoke the real ``fusionkit`` CLI from the test environment.

    Prefers the console script installed in the active venv (what ``uv run
    pytest`` provides); falls back to invoking the Typer app through the
    current interpreter so the harness also works under a bare virtualenv.
    """
    script = shutil.which("fusionkit")
    if script is not None:
        return [script]
    return [sys.executable, "-c", "from fusionkit_cli.main import app; app()"]


class EngineProcessError(RuntimeError):
    """The engine failed to start; ``log`` carries its captured output."""

    def __init__(self, message: str, log: str) -> None:
        super().__init__(f"{message}\n--- engine log ---\n{log}")
        self.log = log


class EngineProcess:
    """A running ``fusionkit serve`` child process bound to a loopback port.

    Context-manager friendly::

        with EngineProcess(config) as engine:
            httpx.post(f"{engine.url}/v1/chat/completions", json=...)

    ``config`` is serialized to the YAML the CLI loads via ``load_config``, so
    the real config-loading path (including ``.fusionkit/prompts`` overlay
    resolution relative to the config file) runs.
    """

    def __init__(
        self,
        config: FusionConfig | None,
        *,
        host: str = "127.0.0.1",
        env: dict[str, str] | None = None,
        startup_timeout_s: float = _STARTUP_TIMEOUT_S,
        command_args: list[str] | None = None,
    ) -> None:
        """``config`` drives the default ``serve --config <yaml>`` invocation.

        ``command_args`` overrides the subcommand entirely (e.g.
        ``["serve-endpoint", "--id", "solo", ...]``); ``--host``/``--port`` are
        still appended by the harness. Exactly one of the two must be given.
        """
        if (config is None) == (command_args is None):
            raise ValueError("provide exactly one of `config` or `command_args`")
        self._config = config
        self._command_args = command_args
        self._host = host
        self._extra_env = env or {}
        self._startup_timeout_s = startup_timeout_s
        self._proc: subprocess.Popen[bytes] | None = None
        self._config_dir: tempfile.TemporaryDirectory[str] | None = None
        self._log_chunks: list[str] = []
        self._log_lock = threading.Lock()
        self._reader: threading.Thread | None = None
        self.port: int = 0

    # -- lifecycle --------------------------------------------------------

    def start(self) -> EngineProcess:
        if self._proc is not None:
            return self
        self.port = free_port(self._host)
        if self._config is not None:
            self._config_dir = tempfile.TemporaryDirectory(prefix="fusionkit-testkit-engine-")
            config_path = Path(self._config_dir.name) / "config.yaml"
            config_path.write_text(
                yaml.safe_dump(self._config.model_dump(mode="json", exclude_defaults=True))
            )
            subcommand = ["serve", "--config", str(config_path)]
        else:
            subcommand = list(self._command_args or [])
        argv = [
            *_engine_argv(),
            *subcommand,
            "--host",
            self._host,
            "--port",
            str(self.port),
        ]
        self._proc = subprocess.Popen(
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env={**os.environ, **self._extra_env},
        )
        stdout = self._proc.stdout
        assert stdout is not None
        self._reader = threading.Thread(
            target=self._pump_log, args=(stdout,), name="fusionkit-engine-log", daemon=True
        )
        self._reader.start()
        self._wait_ready()
        return self

    def stop(self) -> None:
        if self._proc is not None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self._proc.kill()
                self._proc.wait(timeout=10)
            self._proc = None
        if self._reader is not None:
            self._reader.join(timeout=5)
            self._reader = None
        if self._config_dir is not None:
            self._config_dir.cleanup()
            self._config_dir = None

    def __enter__(self) -> EngineProcess:
        return self.start()

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.stop()

    # -- observation ------------------------------------------------------

    @property
    def url(self) -> str:
        return f"http://{self._host}:{self.port}"

    @property
    def log(self) -> str:
        """Everything the engine printed so far (stdout + stderr, merged)."""
        with self._log_lock:
            return "".join(self._log_chunks)

    # -- internals --------------------------------------------------------

    def _pump_log(self, stream: IO[bytes]) -> None:
        for raw in iter(stream.readline, b""):
            with self._log_lock:
                self._log_chunks.append(raw.decode("utf-8", errors="replace"))

    def _wait_ready(self) -> None:
        assert self._proc is not None
        deadline = time.monotonic() + self._startup_timeout_s
        probe = f"{self.url}/v1/models"
        while time.monotonic() < deadline:
            if self._proc.poll() is not None:
                raise EngineProcessError(
                    f"fusionkit serve exited with code {self._proc.returncode} during startup",
                    self.log,
                )
            try:
                with urllib.request.urlopen(probe, timeout=2.0) as response:
                    if response.status == 200:
                        return
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
                pass
            time.sleep(0.1)
        raise EngineProcessError(
            f"fusionkit serve did not become ready within {self._startup_timeout_s:.0f}s",
            self.log,
        )
