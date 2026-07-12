---
name: lab-experiment
description: >-
  Operate the shared HyperKit experiment lab in lab/ on behalf of one operator:
  propose a new experiment, lock and submit a sweep, monitor/extend it, or
  conclude it with results. Use when asked to "propose an experiment", "add an
  experiment to the lab", "claim an experiment", "lock and run eNNN", "submit
  the sweep", "extend eNNN", "resume the sweep", "conclude eNNN", "write up the
  results of eNNN", or "update the registry/journal". Follows the canonical
  procedures in lab/AGENTS.md; never spends before the proposal PR is merged
  and never exceeds the experiment budget.
---

# Lab Experiment (operate)

`lab/AGENTS.md` is the canonical workflow — read it first, follow it exactly.
This skill is the phase map plus the guardrails that must never be skipped.

## Identify the phase

| User intent | Phase | AGENTS.md procedure |
|---|---|---|
| new experiment idea | Propose | A |
| run a merged proposal | Lock + run | B |
| check on / grow a running sweep | Monitor / extend | C |
| finished, write it up | Conclude | D (+ E, F) |

## Propose (no money yet)

```
- [ ] Read lab/REGISTRY.md + claim/Out-of-scope of every non-abandoned experiment.md
- [ ] Overlap or adjacency with an existing claim? STOP, report conflicting id to operator
- [ ] Next free eNNN + slug; create lab/experiments/<id>/
- [ ] Write experiment.md (front matter status: proposed; all length caps) + experiment.py
- [ ] Regenerate REGISTRY.md from front matter (procedure E)
- [ ] Branch + PR containing only this experiment; wait for merge — do not run anything
```

## Lock and run (merged proposals only)

```
- [ ] hyperkit plan experiment.py --workdir work --sweep-id <id> --spend-ceiling-usd <budget_usd>
- [ ] cp work/sweep.lock.json sweep.lock.json; status -> locked; regenerate registry; commit to main
- [ ] hyperkit apply --workdir work --backend aws-batch; status -> running; commit
```

`--spend-ceiling-usd` is mandatory. `sweep_id` must equal the experiment id.

## Monitor / extend

- Progress: `hyperkit status --workdir work` and Grafana (`run_id = <sweep_id>`).
  Never write live progress numbers into git.
- Interruption/restart: `hyperkit resume --workdir work`.
- Same question, more cells: edit `experiment.py`, `hyperkit extend`, re-copy
  and commit the lock, one line under Design. New question = new proposal.

## Conclude

```
- [ ] hyperkit collect --workdir work (and/or Athena) for final numbers
- [ ] Fill Results (with CIs + links), Decision, Follow-ups; set spent_usd; status -> analyzed
- [ ] Regenerate REGISTRY.md; commit to main
- [ ] JOURNAL.md entry ONLY if the outcome changes what the other operator should run next
```

## Never

- Run a sweep whose proposal PR is unmerged.
- Edit the other operator's `experiment.md`, hand-edit `REGISTRY.md`, or edit
  past JOURNAL entries.
- Commit `work/`, result payloads, or secrets.
- Proceed silently past a suspected claim overlap — report to the operator.
