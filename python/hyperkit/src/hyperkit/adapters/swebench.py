"""SWE-bench Verified benchmark adapter.

Runs the benchmark's own scaffold (mini-SWE-agent) against an opaque SUT
endpoint and grades with the official SWE-bench harness; parses harness report
JSON into {instance_id: resolved} for aggregation. The ``run_instance`` path
shells out to the scaffold (used by the compute backend); the ``parse_report``
path reads committed reports (used by ``collect`` and the acceptance test) with
no execution.
"""

from __future__ import annotations

import json
import os
import subprocess
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from hyperkit.core import registry
from hyperkit.core.manifests import TextManifest
from hyperkit.core.models import ResourceProfile, SUTTarget


class SwebenchGrader:
    def grade(self, instance_id: str, raw_output: dict[str, Any]) -> dict[str, Any]:
        # The official harness grades a whole predictions file; per-instance
        # grading here reflects a report already computed by run_instance.
        return {"resolved": bool(raw_output.get("resolved", False))}


class SwebenchAdapter:
    name = "swebench_verified"
    version = "1"
    dataset_name = "princeton-nlp/SWE-bench_Verified"

    def manifest(self, ref: str) -> TextManifest:
        return TextManifest(ref)

    def resource_profile(self) -> ResourceProfile:
        # SWE-bench instance images are GB-scale; this reservation is what the
        # compute backend uses to avoid the host OOM that manual worker caps
        # were firefighting.
        return ResourceProfile(vcpu=2.0, memory_gb=6.0, needs_docker=True, wall_clock_s=5400)

    def grader(self) -> SwebenchGrader:
        return SwebenchGrader()

    def run_instance(
        self, instance_id: str, target: SUTTarget, workdir: Path
    ) -> dict[str, Any]:  # pragma: no cover - requires Docker + billed models
        """Run mini-SWE-agent on one instance, grade with the official harness.

        Returns {"resolved": bool, "report": <harness report subset>}. This path
        is exercised by the compute backend, not by unit tests.
        """

        workdir.mkdir(parents=True, exist_ok=True)
        run_filter = f"^{instance_id}$"
        subprocess.run(
            [
                "mini-extra",
                "swebench",
                "--subset",
                "verified",
                "--split",
                "test",
                "--filter",
                run_filter,
                "-m",
                target.scaffold_model,
                "-c",
                "swebench.yaml",
                "-c",
                f"model.model_kwargs.api_base={target.base_url}",
                "-o",
                str(workdir),
                "-w",
                "1",
            ],
            check=True,
            env={**os.environ, "MSWEA_COST_TRACKING": "ignore_errors"},
        )
        report = self._grade_predictions(workdir, instance_id)
        resolved = instance_id in set(report.get("resolved_ids", []))
        return {"resolved": resolved, "report": report}

    def _grade_predictions(
        self, workdir: Path, instance_id: str
    ) -> dict[str, Any]:  # pragma: no cover - requires Docker
        subprocess.run(
            [
                "python",
                "-m",
                "swebench.harness.run_evaluation",
                "--dataset_name",
                self.dataset_name,
                "--predictions_path",
                str(workdir / "preds.json"),
                "--max_workers",
                "1",
                "--run_id",
                instance_id,
            ],
            check=True,
        )
        reports = sorted(workdir.glob("*.json"))
        for path in reports:
            data = json.loads(path.read_text())
            if "resolved_ids" in data:
                return data
        return {}

    def parse_report(self, report: dict[str, Any], instances: Sequence[str]) -> dict[str, bool]:
        """Map an official SWE-bench harness report to {instance_id: resolved}."""

        resolved = set(report.get("resolved_ids", []))
        wanted = set(instances)
        return {inst: (inst in resolved) for inst in wanted}


def _factory() -> SwebenchAdapter:
    return SwebenchAdapter()


registry.register_benchmark(_factory())
