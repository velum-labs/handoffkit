"""Execution-guided best-of-N selection for code fusion (the SOTA paradigm).

Given several candidate solutions for a task (multiple models x multiple samples),
each is run against the problem's PUBLIC tests; the candidate passing the most public
tests is selected and then graded on the held-out PRIVATE tests. Selection therefore
uses only information available to the solver (public tests), and grading is on
private tests, so it is leakage-free. With sampling diversity the oracle over the
pool exceeds any single model's pass@1, and public-test filtering reliably captures
it -- so the fused (selected) answer beats the best individual model.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CandidateSample:
    """One generated solution, scored on public (selection) and private (grading)."""

    model_id: str
    public_passed: int
    public_total: int
    private_pass: bool

    @property
    def public_all(self) -> bool:
        return self.public_total > 0 and self.public_passed == self.public_total


def select_index(samples: list[CandidateSample]) -> int:
    """Index of the execution-selected candidate.

    Ranking key (higher is better): (passes all public, # public tests passed). Ties
    break to the earliest sample (deterministic). With no public tests, falls back to
    the first sample.
    """
    if not samples:
        raise ValueError("select_index requires at least one sample")
    best_index = 0
    best_key = (-1, -1)
    for index, sample in enumerate(samples):
        key = (1 if sample.public_all else 0, sample.public_passed)
        if key > best_key:
            best_key = key
            best_index = index
    return best_index


def selected_private_pass(samples: list[CandidateSample]) -> bool:
    """Whether the execution-selected candidate passes the private tests."""
    return samples[select_index(samples)].private_pass


__all__ = ["CandidateSample", "select_index", "selected_private_pass"]
