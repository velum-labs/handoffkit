# Why fusion lost the two instances terminus solved solo

Companion to `report.md`. Every claim below is recomputed from committed run
artifacts (`runs/*/preds.json`, trajectories, official grading reports) —
patch hashes and test bodies were verified directly.

Provenance note (2026-07-07, after deviation 3 in `preregistration.md`): a
zombie runner later overwrote 5 fused trajectories (including
pylint-7080's) in the shared output dir. All patch-level claims here were
re-verified against the official grading logs' immutable `patch.diff`
copies (hashes in `graded_patch_hashes.txt`); trajectory-level claims for
pylint (step counts, test commands) came from the legitimate run's
trajectory read before the overwrite and can no longer be regenerated.

Expectation being analyzed: with `select`-style step fusion, fused should be
at least as good as its best member wherever a member can solve the task.
It wasn't, twice. The two failures have different mechanisms.

## Case 1 — `pylint-dev__pylint-7080`: pure judge selection loss

**The smoking gun:** the fused run's final patch is **byte-identical** to
qwen3's failed solo patch (sha256 prefix `3b38cdbf` for both; terminus solo:
`1e567de1`, resolved).

- The bug: `--recursive=y` ignores `ignore-paths` when run from the current
  directory. Terminus solo (81 steps) fixed the real mechanism: relativize
  paths before matching ignore patterns in the directory walk. Qwen3's fix
  (and the fused run's committed path) filters files through
  `_is_ignored_file` in the file-listing branch — plausible, compiles,
  passes a naive repro, and misses the actual current-dir case
  (`tests/test_self.py::TestRunTC::test_ignore_path_recursive_current_dir`:
  FAIL_TO_PASS 0/1).
- **Why the loop couldn't self-correct:** the fused run verified against
  `tests/lint/test_pylinter.py -k recursive`, which the shallow fix
  passes. The discriminating test lives in `tests/test_self.py`. The judge
  ranks step proposals; once the trajectory's own verification signal is
  green, nothing downstream vetoes the wrong mechanism.
- Note: the judge model is terminus-family, and it still committed the
  qwen3-style path — the family-self-preference worry cut the other way
  here.

This is exactly the "confident dead end" failure mode step-judging must
beat. It is a judge/verification design problem, not a fanout problem.

## Case 2 — `astropy__astropy-14508`: near-miss + regression blindness

**The fused patch actually fixed the target bug** (FAIL_TO_PASS 1/1). It
failed grading on a single regression out of 174 passing tests:
`test_header.py::TestHeaderFunctions::test_invalid_float_cards2`.

- Both terminus solo and fused used the same strategy (`str(value)` first,
  fall back to `.16G`). Terminus solo's version also uppercased `e -> E`
  and appended `.0` on the str path; the fused version did neither
  (verified in the patches). The regressed test writes `5.0022221e-07` to
  a header and then seeks to the **hard-coded byte offset of the exponent
  `E`** to corrupt it — a lowercase `e` breaks it. FITS float formatting
  needs the uppercase conversion; the fused variant was the same idea,
  minus the two safety details.
- **The panel was terminus + dead weight here:** qwen3's solo run submitted
  an **empty patch** on this instance. So fusion couldn't have added
  content; it re-rolled terminus down a slightly less careful path, and
  no second member existed to supply the missing edge case.
- **Verification gap:** the fused run tested `test_card.py -k float` only;
  the regression lives in `test_header.py`. One broader
  `pytest astropy/io/fits/tests/` before submitting would have caught it.

## What the two cases say together

1. **Neither failure is about fanout or wire mechanics.** The step-mode
   plumbing did its job; the losses happened in *what got committed* and
   *what got verified* — consistent with the Phase-0 lead that fusion
   value concentrates in judge/synthesis design.
2. **The upside and downside of k=1 are the same mechanism** — committing
   steps neither member would follow alone. The fused-only win
   (`django__django-12125`) and both losses all came from step path
   construction/selection, not from whole-trajectory choice.
3. **[AMENDED 2026-07-07] Actionable levers, reprioritized.** The original
   version of this list put panel quality first, on the strength of the
   "zero headroom" reading now amended in `report.md` (selection oracle is
   a lower frame for k=1; the subset relation at n=10 is noise-compatible).
   Since both losses were winnable with this exact panel, the nearest
   gradient is aggregation:
   - **Traced autopsy first** (pre-registered path): were the fatal
     commits near-ties (prompt-fixable) or confident wrong picks
     (judge-model problem)? Diagnose before tuning.
   - **Aggregation variants on the fixed panel + dev slice:** e.g.
     verification pressure (prefer candidates whose next step broadens
     test coverage before submission — both losses were plausibly
     catchable by one wider test run), regression-risk weighting in the
     judge contract, panel-external judge.
   - **Panel quality** stays real (qwen3 contributed an empty patch on one
     instance) but is a later, separate round — untested, not falsified.
