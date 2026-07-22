---
name: lab-report
description: >-
  Answer questions about the shared HyperKit experiment lab in lab/ without
  changing anything: what experiments exist, what is running, what the latest
  results and decisions were, who owns what, which follow-ups are up for grabs,
  and whether a proposed idea overlaps an existing claim. Use when asked "what
  were the results of the last experiments", "what experiment was this", "what
  is running right now", "summarize eNNN", "what did we learn about <topic>",
  "what follow-ups are open", "did anyone already run <idea>", or for a lab
  status report. Read-only: reads REGISTRY.md, experiment.md files, JOURNAL.md,
  and (only for raw detail) Athena/Grafana.
---

# Lab Report (read-only)

Answer from the committed record. Do not modify any file in `lab/`; if the
record looks stale or inconsistent, say so instead of fixing it.

## Reading order

1. `lab/REGISTRY.md` — index of every experiment: id, owner, status,
   benchmark, claim, budget, spent.
2. `lab/experiments/<id>/experiment.md` — per-experiment truth. Front matter
   for state (`status`, `updated`, `spent_usd`); sections for substance
   (Hypothesis, Design, Out of scope, Results, Decision, Follow-ups).
3. `lab/JOURNAL.md` — newest-first cross-experiment log; only entries that
   affected shared plans.
4. `sweep.lock.json` — exact frozen cell matrix, generations, repo SHA.
5. Grafana (`run_id` = experiment id) / Athena (`sweep_id` partition) — live
   progress and raw per-shard data. Go here only when the question needs
   numbers beyond the Results section.

## Question -> source

| Question | Answer from |
|---|---|
| results of the last experiments | registry rows `analyzed`, sorted by `updated` in front matter; then each Results + Decision |
| what was experiment X | its experiment.md: claim, Hypothesis, Design, Results, Decision |
| what is running / planned | registry `status` column (`running`, `locked`, `proposed`) |
| what exactly did X run | experiment.py + sweep.lock.json |
| open follow-ups | Follow-ups sections marked `up-for-grabs` |
| did anyone already run <idea> | claim column + Out-of-scope sections; note near-misses, not just exact matches |
| how much have we spent | `spent_usd` (analyzed) and `budget_usd` (in flight) across front matter |
| live progress of a sweep | Grafana filtered to `run_id = <id>`; do not write it back into git |

## Answer style

- Lead with the direct answer, then cite experiment ids and quote the Decision
  line where relevant.
- Report Results numbers with their confidence intervals as written; never
  restate a point estimate without its interval.
- Distinguish clearly between analyzed conclusions, in-flight sweeps, and
  merely proposed claims.
- If two sources disagree (e.g. registry vs front matter), report the
  discrepancy — front matter wins.
