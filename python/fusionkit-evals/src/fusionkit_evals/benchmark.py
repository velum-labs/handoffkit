from __future__ import annotations

import json
import time
from collections.abc import Callable, Iterable
from pathlib import Path

from fusionkit_core.config import FusionMode
from fusionkit_core.fusion import FusionEngine
from fusionkit_core.types import ChatMessage

from fusionkit_evals.schema import EvalResult, EvalSample
from fusionkit_evals.scorers import contains_expected

Scorer = Callable[[str, str | None], float | None]


class BenchmarkRunner:
    def __init__(self, engine: FusionEngine, scorer: Scorer = contains_expected) -> None:
        self.engine = engine
        self.scorer = scorer

    async def run_samples(
        self,
        samples: Iterable[EvalSample],
        config_id: str,
        mode: FusionMode,
    ) -> list[EvalResult]:
        results = []
        for sample in samples:
            started = time.perf_counter()
            fusion_result = await self.engine.run(
                [ChatMessage(role="user", content=sample.prompt)],
                mode=mode,
            )
            latency_s = time.perf_counter() - started
            results.append(
                EvalResult(
                    sample_id=sample.id,
                    config_id=config_id,
                    mode=mode,
                    output=fusion_result.content,
                    score=self.scorer(fusion_result.content, sample.expected),
                    latency_s=latency_s,
                    metadata={
                        "fusion_mode": fusion_result.mode,
                        "route": fusion_result.route,
                    },
                )
            )
        return results


def load_jsonl_samples(path: str | Path) -> list[EvalSample]:
    samples = []
    with Path(path).open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                samples.append(EvalSample.model_validate_json(line))
    return samples


def write_jsonl_results(path: str | Path, results: Iterable[EvalResult]) -> None:
    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        for result in results:
            handle.write(json.dumps(result.model_dump(mode="json")) + "\n")
