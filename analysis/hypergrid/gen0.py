"""Generation 0 of the hypergrid fusion hill-climb (see PLAN.md).

DRAFT -- experiments are not approved to start. This module defines the
generation-0 cells (SOTA anchors + open-weight solo screen + kernel-probe
templates) as data, so the grid can be previewed, costed, and reviewed before
any billed shard runs. Once the `livecodebench` hyperkit adapter lands
(PLAN.md Phase 1) this module is loadable by `hyperkit plan` unchanged.

Layout:
- ANCHORS: closed-frontier yardstick cells. Run once per split, never fused,
  never re-tuned.
- OPEN_UNIVERSE: every open-weight endpoint in the search universe, screened
  solo on the full dev split to establish the floor + complementarity matrix.
- KERNEL_PROBES: kernel templates instantiated by the supervisor against the
  top-2 solos from the screen (panels are intentionally unresolved here).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from hyperkit import Cell, Experiment, TopologySpec, experiment
from hyperkit.core.ids import hash_ids

ROOT = Path(__file__).resolve().parents[2]
MANIFEST_DIR = ROOT / "analysis" / "hypergrid" / "manifests"
DEV_MANIFEST = MANIFEST_DIR / "dev.txt"
BENCHMARK = "livecodebench"

# Instance-budget rungs for successive halving. All dev cells pin
# dataset_hash to the FULL dev manifest so promotion to a larger rung
# re-runs only the new instances (see PLAN.md, shard-reuse protocol).
RUNG_SCREEN = 110
RUNG_PROBE = 60

# --- Endpoint universe -------------------------------------------------------
# id -> (openrouter model, input $/M, output $/M, est. output tokens/task)
# Prices validated against the OpenRouter catalog on 2026-07-12
# (analysis/hypergrid/STARTING_POINT.md has the full table).

OPEN_UNIVERSE: dict[str, tuple[str, float, float, int]] = {
    "ds32": ("deepseek/deepseek-v3.2", 0.214, 0.322, 6000),
    "dsv4pro": ("deepseek/deepseek-v4-pro", 0.435, 0.870, 8000),
    "terminus": ("deepseek/deepseek-v3.1-terminus", 0.270, 0.950, 5000),
    "r1": ("deepseek/deepseek-r1-0528", 0.500, 2.150, 12000),
    "qwen3t": ("qwen/qwen3-235b-a22b-thinking-2507", 0.150, 1.495, 12000),
    "qwen37max": ("qwen/qwen3.7-max", 1.250, 3.750, 8000),
    "glm52": ("z-ai/glm-5.2", 0.420, 1.320, 8000),
    "kimi26": ("moonshotai/kimi-k2.6", 0.660, 3.410, 8000),
    "nemotron3s": ("nvidia/nemotron-3-super-120b-a12b", 0.080, 0.450, 8000),
    "kimikt": ("moonshotai/kimi-k2-thinking", 0.600, 2.500, 12000),
    "qwen3c": ("qwen/qwen3-coder", 0.220, 1.800, 5000),
}

# Closed-frontier anchors (yardstick only; never inside a fused cell).
ANCHORS: dict[str, tuple[str, float, float, int]] = {
    "anchor-gpt55": ("openai/gpt-5.5", 5.0, 30.0, 6000),
    "anchor-opus48": ("anthropic/claude-opus-4.8", 5.0, 25.0, 6000),
}

EST_INPUT_TOKENS = 2000  # median dev prompt ~1.6k chars + suffix + margin

# Kernel-probe templates. `panel: None` means "resolved by the supervisor
# from the top-2 screened solos" -- these cells are NOT materialized by
# cells(); they document generation 0b and drive the cost preview.
KERNEL_PROBES: list[dict[str, Any]] = [
    {
        "kernel": "judge-synth",
        "panel": None,
        "serve": {"default_mode": "panel", "synthesis_select_best": False},
        "calls_per_task": 4,  # 2 panel + judge + synth
    },
    {
        "kernel": "judge-select",
        "panel": None,
        "serve": {"default_mode": "panel", "synthesis_select_best": True},
        "calls_per_task": 3,  # 2 panel + judge (verbatim select)
    },
    {
        "kernel": "self-moa",
        "panel": None,  # single best solo, high-temperature diversity
        "serve": {
            "default_mode": "self",
            "sample_count": 4,
            "synthesis_select_best": False,
            "sampling": {"temperature": 0.8},
        },
        "calls_per_task": 6,  # 4 samples + judge + synth
    },
    {
        "kernel": "exec-select",
        "panel": None,  # composes with any generator behind the endpoint
        "params": {"n_samples": 3, "selection": "public-exec", "temps": [0.2, 0.6, 0.9]},
        "calls_per_task": 3,
    },
]


def _read_manifest(path: Path) -> list[str]:
    lines = path.read_text(encoding="utf-8").splitlines()
    return [ln.strip() for ln in lines if ln.strip() and not ln.startswith("#")]


def solo_endpoint_params(endpoint_id: str) -> dict[str, Any]:
    universe = {**OPEN_UNIVERSE, **ANCHORS}
    model, _, _, _ = universe[endpoint_id]
    return {"provider": "openrouter", "model": model}


def build_serve_config(
    panel: list[str],
    *,
    judge: str,
    synthesizer: str,
    overrides: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Materialize a fusionkit `serve_config` payload from universe endpoint ids.

    Only open-weight endpoints are legal panel/judge/synthesizer members --
    anchors are a yardstick, not an ingredient.
    """

    members = set(panel) | {judge, synthesizer}
    illegal = members & set(ANCHORS)
    if illegal:
        raise ValueError(f"closed anchors may not appear in a fused cell: {sorted(illegal)}")
    unknown = members - set(OPEN_UNIVERSE)
    if unknown:
        raise ValueError(f"unknown endpoints: {sorted(unknown)}")

    endpoints = [
        {
            "id": endpoint_id,
            "provider": "openrouter",
            "model": OPEN_UNIVERSE[endpoint_id][0],
            "base_url": "https://openrouter.ai/api",
            "api_key_env": "OPENROUTER_API_KEY",
        }
        for endpoint_id in sorted(members)
    ]
    # FusionConfig is flat: fusion fields sit at the top level beside endpoints
    # (see configs/benchmark-panel.gpt-opus.yaml).
    config: dict[str, Any] = {
        "endpoints": endpoints,
        "default_model": judge,
        "judge_model": judge,
        "synthesizer_model": synthesizer,
        "panel_models": list(panel),
        "default_mode": "panel",
        "harness_prompt_passthrough": True,
        "sampling": {"temperature": 0.2, "top_p": 0.95, "max_tokens": 16384},
    }
    config.update(overrides or {})
    return config


@experiment(id="hypergrid-gen0")
class Gen0(Experiment):
    """Anchors + open-weight solo screen. Kernel probes (gen 0b) are appended
    by the supervisor via `hyperkit extend` once the screen names the top-2."""

    def cells(self, ctx: Any):
        instances = _read_manifest(DEV_MANIFEST)
        dataset_hash = hash_ids(instances)

        for endpoint_id in sorted(ANCHORS):
            yield Cell(
                sut=TopologySpec(kind="solo-model", params=solo_endpoint_params(endpoint_id)),
                benchmark=BENCHMARK,
                instances=instances[:RUNG_SCREEN],
                manifest_ref=str(DEV_MANIFEST),
                dataset_hash=dataset_hash,
                label=endpoint_id,
            )
        for endpoint_id in sorted(OPEN_UNIVERSE):
            yield Cell(
                sut=TopologySpec(kind="solo-model", params=solo_endpoint_params(endpoint_id)),
                benchmark=BENCHMARK,
                instances=instances[:RUNG_SCREEN],
                manifest_ref=str(DEV_MANIFEST),
                dataset_hash=dataset_hash,
                label=f"solo-{endpoint_id}",
            )
