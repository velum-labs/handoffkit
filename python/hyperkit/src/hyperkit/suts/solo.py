"""Generic direct-model SUT (no local process)."""

from __future__ import annotations

from pathlib import Path

from hyperkit.core import registry
from hyperkit.core.models import SUTTarget, TopologySpec


class SoloModelSUT:
    kind = "solo-model"

    def start(self, spec: TopologySpec, workdir: Path) -> SUTTarget:
        params = spec.params
        model = str(params["model"])
        provider = str(params.get("provider", "openai"))
        base_url = str(params.get("base_url", "https://openrouter.ai/api/v1"))
        # liteLLM's provider prefix is independent of the API's URL.
        prefix = str(params.get("provider_prefix", provider))
        return SUTTarget(base_url=base_url, model=model, provider_prefix=prefix)

    def stop(self) -> None:
        return None


registry.register_sut(SoloModelSUT())

