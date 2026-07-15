"""HyperKit SUT plugin for the Node-owned FusionKit gateway."""

from __future__ import annotations

import json
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


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class FusionKitGatewaySUT:
    """Launch the Node gateway, which in turn owns the Python sidecar."""

    kind = "fusionkit-serve"

    def __init__(self) -> None:
        self._process: subprocess.Popen[bytes] | None = None
        self._log: BinaryIO | None = None

    def start(self, spec: TopologySpec, workdir: Path) -> SUTTarget:
        project_dir = self._materialize_project(spec, workdir)
        port = _free_port()
        binary = shutil.which("fusionkit")
        if binary is None:
            raise RuntimeError("Node fusionkit executable is not on PATH")
        log = (workdir / "fusionkit-gateway.log").open("wb")
        self._log = log
        self._process = subprocess.Popen(
            [binary, "serve", "--no-portless", "--port", str(port)],
            cwd=project_dir,
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
                        model=str(spec.params.get("model", "fusionkit/panel")),
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

    def _materialize_project(self, spec: TopologySpec, workdir: Path) -> Path:
        workdir.mkdir(parents=True, exist_ok=True)
        existing = spec.params.get("project_dir")
        if existing:
            path = Path(str(existing)).resolve()
            if not path.is_dir():
                raise FileNotFoundError(f"FusionKit project directory not found: {path}")
            return path

        fusion_config = spec.params.get("fusion_config")
        routekit_config = spec.params.get("routekit_config")
        if not isinstance(fusion_config, dict) or not isinstance(routekit_config, dict):
            if "serve_config" in spec.params:
                raise ValueError(
                    "serve_config is the removed Python provider schema; use "
                    "fusion_config plus routekit_config so the Node gateway owns routing"
                )
            raise ValueError(
                "fusionkit-serve requires params.project_dir or both "
                "params.fusion_config and params.routekit_config"
            )

        fusion_dir = workdir / ".fusionkit"
        routekit_dir = workdir / ".routekit"
        fusion_dir.mkdir(exist_ok=True)
        routekit_dir.mkdir(exist_ok=True)
        (fusion_dir / "fusion.json").write_text(
            json.dumps(fusion_config, indent=2) + "\n",
            encoding="utf-8",
        )
        (routekit_dir / "router.yaml").write_text(
            yaml.safe_dump(routekit_config, sort_keys=False),
            encoding="utf-8",
        )
        return workdir


def factory() -> FusionKitGatewaySUT:
    return FusionKitGatewaySUT()


__all__ = ["FusionKitGatewaySUT", "factory"]
