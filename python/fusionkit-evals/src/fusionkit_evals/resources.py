from __future__ import annotations

from importlib.resources import files
from pathlib import Path


def packaged_data_path(*parts: str) -> Path:
    """Resolve packaged eval data, with source-tree fallbacks for local checkouts."""
    resource = files("fusionkit_evals").joinpath("data", *parts)
    candidates = [_as_path(resource), Path(__file__).resolve().parent.joinpath("data", *parts)]
    # Compatibility for scripts run from older checkouts before data lived under src/.
    if parts and parts[0] == "fixtures":
        candidates.append(Path(__file__).resolve().parents[2].joinpath("fixtures", *parts[1:]))
    if parts and parts[0] == "benchmarks":
        candidates.append(Path(__file__).resolve().parents[2].joinpath("benchmarks", *parts[1:]))
    for candidate in candidates:
        if candidate is not None and candidate.exists():
            return candidate
    missing = Path("data").joinpath(*parts)
    raise FileNotFoundError(f"Packaged fusionkit-evals data not found: {missing}")


def _as_path(resource: object) -> Path | None:
    try:
        return Path(resource)  # type: ignore[arg-type]
    except TypeError:
        return None
