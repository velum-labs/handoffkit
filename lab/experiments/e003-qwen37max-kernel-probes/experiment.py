"""Kernel probes on the e002 frontier: qwen3.7-max solo-diversity and the
qwen3.7-max + r1 pair (the only complementarity-positive partner)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from hyperkit import Cell, Experiment, TopologySpec, experiment
from hyperkit.core.ids import hash_ids

ROOT = Path(__file__).resolve().parents[3]
DEV_MANIFEST = ROOT / "analysis" / "hypergrid" / "manifests" / "dev.txt"
BENCHMARK = "livecodebench"

Q37 = "qwen/qwen3.7-max"
R1 = "deepseek/deepseek-r1-0528"

# Multi-stage and multi-sample cells must record timeouts instead of
# re-billing them (e001 lesson; e002 confirmed the long provider tail).
FUSED_HARNESS = {"attempts": 2, "request_timeout_s": 1800.0}


def _instances() -> list[str]:
    return [
        line.strip()
        for line in DEV_MANIFEST.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.startswith("#")
    ]


def _serve_config(*, select_best: bool, self_mode: bool) -> dict[str, Any]:
    endpoints = [
        {
            "id": "q37",
            "provider": "openrouter",
            "model": Q37,
            "base_url": "https://openrouter.ai/api",
            "api_key_env": "OPENROUTER_API_KEY",
        },
        {
            "id": "r1",
            "provider": "openrouter",
            "model": R1,
            "base_url": "https://openrouter.ai/api",
            "api_key_env": "OPENROUTER_API_KEY",
        },
    ]
    config: dict[str, Any] = {
        "endpoints": endpoints,
        "default_model": "q37",
        "judge_model": "q37",
        "synthesizer_model": "q37",
        "panel_models": ["q37"] if self_mode else ["q37", "r1"],
        "default_mode": "self" if self_mode else "panel",
        "synthesis_select_best": select_best,
        "harness_prompt_passthrough": True,
        "sampling": {"temperature": 0.8 if self_mode else 0.2, "top_p": 0.95, "max_tokens": 16384},
    }
    if self_mode:
        config["sample_count"] = 3
    return config


@experiment(id="e003-qwen37max-kernel-probes")
class KernelProbes(Experiment):
    def cells(self, ctx: Any):
        instances = _instances()
        dataset_hash = hash_ids(instances)

        def cell(label: str, sut: TopologySpec, params: dict[str, Any]) -> Cell:
            return Cell(
                sut=sut,
                benchmark=BENCHMARK,
                instances=instances,
                manifest_ref=str(DEV_MANIFEST),
                dataset_hash=dataset_hash,
                params=params,
                label=label,
            )

        solo_q37 = TopologySpec(
            kind="solo-model", params={"provider": "openrouter", "model": Q37}
        )
        yield cell(
            "exec-q37-n3",
            solo_q37,
            {
                "topology": "exec-select",
                "n_samples": 3,
                "temps": [0.2, 0.6, 0.9],
                "selection": "public-exec",
                **FUSED_HARNESS,
            },
        )
        yield cell(
            "exec-repair-q37-n3",
            solo_q37,
            {
                "topology": "exec-select-repair",
                "n_samples": 3,
                "temps": [0.2, 0.6, 0.9],
                "selection": "public-exec-repair",
                **FUSED_HARNESS,
            },
        )
        yield cell(
            "selfmoa-q37-s3",
            TopologySpec(
                kind="fusionkit-serve",
                params={"serve_config": _serve_config(select_best=False, self_mode=True)},
            ),
            {"topology": "self-moa", "panel": ["q37"], "judge": "q37", **FUSED_HARNESS},
        )
        yield cell(
            "judge-select-q37r1",
            TopologySpec(
                kind="fusionkit-serve",
                params={"serve_config": _serve_config(select_best=True, self_mode=False)},
            ),
            {
                "topology": "judge-select",
                "panel": ["q37", "r1"],
                "judge": "q37",
                **FUSED_HARNESS,
            },
        )
        yield cell(
            "judge-synth-q37r1",
            TopologySpec(
                kind="fusionkit-serve",
                params={"serve_config": _serve_config(select_best=False, self_mode=False)},
            ),
            {
                "topology": "judge-synth",
                "panel": ["q37", "r1"],
                "judge": "q37",
                **FUSED_HARNESS,
            },
        )
