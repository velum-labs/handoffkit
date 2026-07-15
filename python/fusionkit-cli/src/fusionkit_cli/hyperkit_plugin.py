"""hyperkit SystemUnderTest plugin for ``fusionkit serve``.

This module is the dependency-direction seam: FusionKit imports hyperkit's
opaque ``TopologySpec`` and translates it into a serve config; hyperkit core
never imports FusionKit. Registered via the ``hyperkit.suts`` entry-point.
"""

from __future__ import annotations

import os
import shutil
import signal
import socket
import subprocess
import time
import urllib.request
from pathlib import Path
from typing import BinaryIO

import yaml
from hyperkit.core.models import SUTTarget, TopologySpec

_FUSION_ALIASES = {"heuristic", "panel", "self", "single"}


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class FusionKitServeSUT:
    kind = "fusionkit-serve"

    def __init__(self) -> None:
        self._process: subprocess.Popen[bytes] | None = None
        self._log: BinaryIO | None = None

    def start(self, spec: TopologySpec, workdir: Path) -> SUTTarget:
        workdir.mkdir(parents=True, exist_ok=True)
        config = self._materialize_config(spec, workdir)
        port = _free_port()
        binary = shutil.which("fusionkit")
        if binary is None:
            raise RuntimeError("fusionkit executable is not on PATH")
        log = (workdir / "fusionkit-serve.log").open("wb")
        self._log = log
        self._process = subprocess.Popen(
            [
                binary,
                "serve",
                "-c",
                str(config),
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
            ],
            stdout=log,
            stderr=subprocess.STDOUT,
            env=os.environ.copy(),
            start_new_session=True,
        )
        url = f"http://127.0.0.1:{port}"
        for _ in range(60):
            if self._process.poll() is not None:
                raise RuntimeError(
                    f"fusionkit serve exited {self._process.returncode}; see {log.name}"
                )
            try:
                with urllib.request.urlopen(f"{url}/v1/models", timeout=1.0):
                    return SUTTarget(
                        base_url=f"{url}/v1",
                        model=self._target_model(spec, config),
                    )
            except OSError:
                time.sleep(1)
        self.stop()
        raise TimeoutError("fusionkit serve did not become healthy within 60s")

    def stop(self) -> None:
        process = self._process
        self._process = None
        log = self._log
        self._log = None
        if process is None or process.poll() is not None:
            if log is not None:
                log.close()
            return
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
        if log is not None:
            log.close()

    def _materialize_config(self, spec: TopologySpec, workdir: Path) -> Path:
        params = spec.params
        existing = params.get("config")
        if existing:
            path = Path(str(existing)).resolve()
            if not path.exists():
                raise FileNotFoundError(f"fusionkit config not found: {path}")
            return path

        # Registered topology recipes ultimately materialize the same serve
        # schema. Until the TS-kernel TopologySpec bridge lands, accept a fully
        # resolved config payload here -- opaque to hyperkit, validated by
        # FusionKit's loader when serve starts.
        payload = params.get("serve_config")
        if not isinstance(payload, dict):
            raise ValueError(
                "fusionkit-serve TopologySpec requires params.config or params.serve_config"
            )
        path = workdir / "fusionkit-config.yaml"
        path.write_text(yaml.safe_dump(payload, sort_keys=False))
        return path

    def _target_model(self, spec: TopologySpec, config: Path) -> str:
        explicit = spec.params.get("model")
        if explicit is not None:
            return str(explicit)

        payload = yaml.safe_load(config.read_text(encoding="utf-8")) or {}
        if not isinstance(payload, dict):
            raise ValueError("fusionkit config must be a mapping")
        mode = str(payload.get("default_mode", "heuristic"))
        if mode not in _FUSION_ALIASES:
            raise ValueError(f"unsupported fusionkit default_mode: {mode!r}")
        return f"fusionkit/{mode}"


def factory() -> FusionKitServeSUT:
    return FusionKitServeSUT()

