"""Terminal-Bench adapter (official ``tb`` harness, one task per shard)."""

from __future__ import annotations

import json
import subprocess
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from hyperkit.core import registry
from hyperkit.core.manifests import TextManifest
from hyperkit.core.models import ResourceProfile, SUTTarget


class TerminalBenchGrader:
    def grade(self, instance_id: str, raw_output: dict[str, Any]) -> dict[str, Any]:
        return {"resolved": bool(raw_output.get("resolved", False))}


class TerminalBenchAdapter:
    name = "terminal_bench"
    version = "1"

    def manifest(self, ref: str) -> TextManifest:
        return TextManifest(ref)

    def resource_profile(self) -> ResourceProfile:
        return ResourceProfile(vcpu=2.0, memory_gb=6.0, needs_docker=True, wall_clock_s=5400)

    def grader(self) -> TerminalBenchGrader:
        return TerminalBenchGrader()

    def run_instance(
        self, instance_id: str, target: SUTTarget, workdir: Path, params: dict[str, Any]
    ) -> dict[str, Any]:  # pragma: no cover - Docker + billed models
        workdir.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [
                "tb",
                "run",
                "--agent",
                "terminus-2",
                "--model",
                target.scaffold_model,
                "--agent-kwarg",
                f"api_base={target.base_url}",
                "--dataset",
                "terminal-bench-core==0.1.1",
                "--task-id",
                instance_id,
                "--output-path",
                str(workdir),
            ],
            check=True,
        )
        reports = sorted(workdir.glob("*/results.json"))
        if not reports:
            raise FileNotFoundError(f"Terminal-Bench produced no results.json under {workdir}")
        report = json.loads(reports[-1].read_text())
        outcomes = self.parse_report(report, [instance_id])
        return {"resolved": outcomes[instance_id], "report": report}

    def parse_report(self, report: dict[str, Any], instances: Sequence[str]) -> dict[str, bool]:
        rows = report.get("results", [])
        resolved = {str(row["task_id"]) for row in rows if row.get("is_resolved")}
        return {instance: instance in resolved for instance in instances}


registry.register_benchmark(TerminalBenchAdapter())

