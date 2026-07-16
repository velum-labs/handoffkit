"""Correctness-gated open-weight recovery canary on fresh hard dev tasks."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from hyperkit import Cell, Experiment, TopologySpec, experiment

ROOT = Path(__file__).resolve().parents[3]
SPARE_MANIFEST = ROOT / "analysis" / "hypergrid" / "manifests" / "spare.txt"
BENCHMARK = "livecodebench"

DSV4 = "deepseek/deepseek-v4-pro"
QWEN3T = "qwen/qwen3-235b-a22b-thinking-2507"
OPEN_WEIGHT_EVIDENCE = {
    DSV4: ("MIT", "https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro"),
    QWEN3T: (
        "Apache-2.0",
        "https://huggingface.co/Qwen/Qwen3-235B-A22B-Thinking-2507",
    ),
}
COHORT = (
    "arc184_c",
    "abc370_f",
    "abc372_g",
    "abc389_g",
    "abc368_f",
    "abc393_e",
    "abc374_g",
    "abc384_e",
    "abc390_f",
    "arc183_b",
    "arc195_e",
    "abc393_f",
    "abc383_e",
    "abc393_d",
    "arc195_d",
    "arc189_c",
    "abc399_e",
    "arc194_e",
    "arc186_a",
    "abc386_e",
    "abc381_e",
    "abc388_e",
    "abc388_f",
    "arc191_d",
)
CONTENT_SHA256 = {
    "abc368_f": "170c2912a9e8ffc1e77824df3e26b63ecc50395c67a9f945ed8e49ee9c1ab6e4",
    "abc370_f": "bdad92198116b857d30f60f1641abf93cba7e34b7fb5aadfeb32d2c319c56c49",
    "abc372_g": "2bfa7f0fe892649c9c0a79205e6eb0e844a890b51318df9aef8f021e7fbb32df",
    "abc374_g": "28252ce134ec626a047f8ea67f4f9a933c79d6df239f67ef8d4c441eba8a510c",
    "abc381_e": "a5a4861db477cefd942e09ce5dde7a03164e89b0c6ade922774328ed5da60f34",
    "abc383_e": "577e50099583995826b701a1c5b37984bc50ab5a67a7a006d31fe15f551ffc2f",
    "abc384_e": "4d25aa97a6a1d68ede92f4bf49119a2ade8c947d34a01222247b99a3c0d6277f",
    "abc386_e": "a162e62e146aff8e8ddc136e5a2a49229c9ed767a936df6cd6529dd2e31920da",
    "abc388_e": "761193539ac489240fb919b39b6cbb0c3d64df83789254cb41dfe7650a9d83bd",
    "abc388_f": "96df5a74d72b18199bb99c73b661ac7ecbaefb47f56649d8ece0a15b541d9046",
    "abc389_g": "8d01e1ef5a3a7bd68b930d2a88b4c0a8b7b53ed7296fcc4723a7e13bedf51f71",
    "abc390_f": "53b3dd906c6323e3f0762a5b9609dd014e2e61a697ac765806b5062e06c5e979",
    "abc393_d": "171483d7cbf39b23ed945327dedb49e384f548e5d865fd0ad290059e5ca6778a",
    "abc393_e": "67a5a8da75de971209e2b8d776c80e33b842a603af4e93335d25dfa7cd0c2547",
    "abc393_f": "6f52211a1e5a47d2260fd141f1c65f327244c53e5dafb7759dbf4bd7c439a631",
    "abc399_e": "44149827a5c2fa8ad004c60560f04a7fda4d6ca6719aaeadcd7c61279d5b233c",
    "arc183_b": "7e0e607b528932924ff9dc51479362f1ac74d1965b2d03f2acda4e8c8fa8899c",
    "arc184_c": "fc4b62d00747e559c6829f2ad9e96a432f1e239db05b13f2bff5c34676734b33",
    "arc186_a": "be0dd369d934fc70b342895c754560c277651637334fc03f4a476b77196f04bd",
    "arc189_c": "0420c5fb76c2ffef016f9087b670f93c8ffc5fcec5702729b6749416b95c8b16",
    "arc191_d": "af132cd9f7e3c8b2a5de5a8d8e125cbd7c00460fc8a9f3b525817227c9eaf78d",
    "arc194_e": "c0d63efe9162585664230e6d9a026771993671a48535fc13ff24021225afa999",
    "arc195_d": "338e6ad5fafe724b5ccd507cf15b15372ac7b05e9f24bade6d376975b6f7c7ed",
    "arc195_e": "2713fe42d14f223cf53b744a2f87f79f74fbc12ccd9b75bb3f65ba113a3a589c",
}
DATASET_HASH = "bc7485d976375b77203a72c55e19c94b757bbb4359d79a0dc5de1a1047fc6edc"

DSV4_PROVIDER = {"order": ["DeepSeek"], "allow_fallbacks": False}
QWEN_PROVIDER = {"order": ["Alibaba"], "allow_fallbacks": False}
REASONING = {"effort": "high", "exclude": True}
COMMON = {
    "dataset_content_sha256": CONTENT_SHA256,
    "max_tokens": 65536,
    "top_p": 0.95,
    "attempts": 1,
    "request_timeout_s": 1800.0,
    "test_timeout_s": 6.0,
    "require_isolation": True,
}


def _self_config() -> dict[str, Any]:
    return {
        "endpoints": [
            {
                "id": "qwen",
                "provider": "openrouter",
                "model": QWEN3T,
                "base_url": "https://openrouter.ai/api",
                "api_key_env": "OPENROUTER_API_KEY",
                "timeout_s": 1800.0,
            }
        ],
        "default_model": "qwen",
        "judge_model": "qwen",
        "synthesizer_model": "qwen",
        "panel_models": ["qwen"],
        "default_mode": "self",
        "sample_count": 4,
        "self_temperatures": [0.2, 0.5, 0.8, 1.0],
        "synthesis_select_best": False,
        "sampling": {
            "temperature": 0.6,
            "top_p": 0.95,
            "max_tokens": 65536,
            "seed": 20260716,
        },
    }


@experiment(id="e005-correctness-recovery-canary")
class CorrectnessRecoveryCanary(Experiment):
    def cells(self, ctx: Any):
        del ctx
        if set(OPEN_WEIGHT_EVIDENCE) != {DSV4, QWEN3T}:
            raise ValueError("every recovery model requires pinned open-weight evidence")
        instances = list(COHORT)

        def cell(label: str, sut: TopologySpec, params: dict[str, Any]) -> Cell:
            return Cell(
                sut=sut,
                benchmark=BENCHMARK,
                instances=instances,
                manifest_ref=str(SPARE_MANIFEST),
                dataset_hash=DATASET_HASH,
                params={**COMMON, **params},
                label=label,
            )

        dsv4 = TopologySpec(
            kind="solo-model",
            params={"provider": "openrouter", "model": DSV4},
        )
        qwen = TopologySpec(
            kind="solo-model",
            params={"provider": "openrouter", "model": QWEN3T},
        )
        yield cell(
            "solo-dsv4pro",
            dsv4,
            {"provider": DSV4_PROVIDER, "reasoning": REASONING, "seed": 20260716},
        )
        yield cell(
            "solo-qwen3t",
            qwen,
            {"provider": QWEN_PROVIDER, "reasoning": REASONING, "seed": 20260717},
        )

        candidate_specs = [
            {
                "model": DSV4,
                "temperature": 0.2,
                "prompt_variant": "Derive the algorithm, invariants, and complexity before coding.",
                "provider": DSV4_PROVIDER,
                "reasoning": REASONING,
                "seed": 20260718,
            },
            {
                "model": QWEN3T,
                "temperature": 0.2,
                "prompt_variant": "Prove key invariants and check every boundary case.",
                "provider": QWEN_PROVIDER,
                "reasoning": REASONING,
                "seed": 20260719,
            },
            {
                "model": QWEN3T,
                "temperature": 0.6,
                "prompt_variant": "Find an algorithmically distinct formulation before coding.",
                "provider": QWEN_PROVIDER,
                "reasoning": REASONING,
                "seed": 20260720,
            },
            {
                "model": QWEN3T,
                "temperature": 0.9,
                "prompt_variant": (
                    "Attack likely greedy/DP assumptions with adversarial edge cases."
                ),
                "provider": QWEN_PROVIDER,
                "reasoning": REASONING,
                "seed": 20260721,
            },
        ]
        yield cell(
            "exec-tie-plan4",
            dsv4,
            {
                "topology": "exec-tie",
                "selection": "public-exec-tie-judge",
                "candidate_specs": candidate_specs,
                "tie_judge_model": QWEN3T,
                "tie_judge_max_tokens": 8192,
                "provider": QWEN_PROVIDER,
                "reasoning": REASONING,
                "seed": 20260722,
            },
        )
        yield cell(
            "exec-repair-plan4",
            dsv4,
            {
                "topology": "exec-repair",
                "selection": "public-exec-repair",
                "candidate_specs": candidate_specs,
            },
        )
        yield cell(
            "self4-qwen-synth",
            TopologySpec(
                kind="fusionkit-serve",
                params={"serve_config": _self_config()},
            ),
            {
                "topology": "self-moa-synth",
                "panel": ["qwen"],
                "judge": "qwen",
                "provider": QWEN_PROVIDER,
                "reasoning": REASONING,
                "seed": 20260716,
                "include_evidence": True,
            },
        )
