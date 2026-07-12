# Shared Experiment Lab — Agent Workflow

You are an agent operating the shared HyperKit experiment lab on behalf of one
of two operators. The other operator's agent follows this same file. Your job
is to keep `lab/` truthful with minimal words, so both operators always know
what has run, what is running, what is planned, and what was learned — and so
new experiments complement rather than duplicate existing ones.

## Division of responsibility (do not re-invent)

- **`lab/` (git)** holds *intent, claims, and conclusions*. That is all you
  maintain. Keep entries short; respect every length cap below.
- **S3 / Athena** hold result data. Never commit result payloads, logs, or
  caches to git — link to them.
- **Grafana** is the live view of running sweeps. Never transcribe live
  numbers into git; only final, analyzed numbers go in `Results`.
- **HyperKit itself** already prevents exact re-execution: shards are
  content-addressed and the S3 store is idempotent. Your overlap duty is at
  the *intent* level (two experiments answering the same question), not the
  shard level.

## Layout

```
lab/
  AGENTS.md                 # this file
  REGISTRY.md               # generated index — NEVER edit by hand
  JOURNAL.md                # append-only cross-experiment log
  experiments/
    e001-swebench-k-sweep/
      experiment.md         # single source of truth (front matter + sections)
      experiment.py         # the hyperkit Experiment (or matrix .yaml)
      sweep.lock.json       # committed copy of the frozen plan
      work/                 # gitignored hyperkit workdir
```

If `lab/` does not exist yet, bootstrap it: create the tree above (empty
`REGISTRY.md` and `JOURNAL.md` with just a title line) and add
`lab/experiments/*/work/` to the repo `.gitignore`.

## experiment.md format

One file per experiment. YAML front matter is the machine-readable state; the
sections are the human-readable record. Nothing in the front matter may
contradict the sections.

```markdown
---
id: e004-terminal-panel-ablation     # eNNN-slug; NNN strictly increasing across the lab
owner: ben                           # operator, not agent
status: proposed                     # proposed | locked | running | analyzed | abandoned
benchmark: terminal_bench
claim: "panel composition at fixed k=4, driver topology"
sweep_id: e004-terminal-panel-ablation   # always equal to id
budget_usd: 150
spent_usd: 0
created: 2026-07-12
updated: 2026-07-12
---

## Hypothesis
(<= 5 lines, falsifiable)

## Design
(axes varied, axes pinned, expected cell/shard counts; <= 10 lines)

## Out of scope
(what this experiment deliberately does NOT cover — this is what lets the
other operator design the complementary experiment; <= 5 lines)

## Decision rule
(written BEFORE running: what result triggers extend / stop / pivot; <= 5 lines)

## Results
(filled at conclusion only: headline numbers WITH confidence intervals,
actual spend, links to Athena query / Grafana dashboard state; <= 15 lines)

## Decision
(what was decided and why; <= 5 lines)

## Follow-ups
(each marked `claimed: <operator>` or `up-for-grabs`; <= 5 items)
```

## Status state machine

```
proposed -> locked -> running -> analyzed
     \---------\---------\-----> abandoned
```

- `proposed`: experiment.md + experiment.py committed and merged; no lock yet.
- `locked`: `hyperkit plan` ran; `sweep.lock.json` committed.
- `running`: shards submitted (`hyperkit apply`).
- `analyzed`: Results + Decision filled in; `spent_usd` set.
- `abandoned`: stopped early; one line in Decision saying why.

Only move forward (or to `abandoned`). Update `updated:` on every change.

## Procedures

### A. Propose (before any money is spent)

1. Read `REGISTRY.md` and the front matter + `Out of scope` of every
   experiment with status other than `abandoned`. Check the new idea against
   existing `claim` lines. If it overlaps or is adjacent to another
   experiment, stop and report to your operator instead of proceeding —
   suggest how to make it complementary.
2. Pick the next free `eNNN` number. Create the folder and write
   `experiment.md` (status `proposed`) and `experiment.py`.
3. Regenerate `REGISTRY.md` (procedure E).
4. Open a PR containing only this experiment. The PR is the claim
   registration; the *other operator* (or their agent) reviews for overlap.
   Do not run anything until it is merged.

### B. Lock and run

1. On the merged experiment, from the experiment folder:

   ```sh
   hyperkit plan experiment.py --workdir work --sweep-id <id> --spend-ceiling-usd <budget_usd>
   cp work/sweep.lock.json sweep.lock.json
   ```

2. Optional mechanical overlap check (informational — exact duplicates are
   deduplicated by HyperKit anyway):

   ```sh
   uv run --package hyperkit python - <<'EOF'
   from pathlib import Path
   from hyperkit.core.lock import load_lock
   locks = {p: load_lock(p) for p in Path("lab/experiments").glob("*/sweep.lock.json")}
   ids = {p: {c.cell_id for c in lk.all_cells()} for p, lk in locks.items()}
   for a in ids:
       for b in ids:
           if str(a) < str(b) and ids[a] & ids[b]:
               print(f"overlap: {a} & {b}: {len(ids[a] & ids[b])} cells")
   EOF
   ```

3. Commit `sweep.lock.json`, set status `locked`, regenerate registry, commit
   directly to main (no PR needed after the proposal is merged).
4. Submit: `hyperkit apply --workdir work --backend aws-batch`. Set status
   `running`, commit.

### C. Monitor and extend

- Progress: `hyperkit status --workdir work`, plus the shared Grafana
  (filter `run_id = <sweep_id>`). Do not write progress into git.
- After Spot interruptions or restarts: `hyperkit resume --workdir work`.
- Follow-up cells within the same question: edit `experiment.py`, run
  `hyperkit extend experiment.py --workdir work`, re-copy and commit the lock.
  Note the extension in one line under `Design`. A genuinely *new question*
  is a new experiment (procedure A), not an extend.

### D. Conclude

1. Aggregate: `hyperkit collect --workdir work` and/or Athena queries.
2. Fill `Results`, `Decision`, `Follow-ups`; set `spent_usd`; set status
   `analyzed`. Respect the length caps — link out for anything longer.
3. Regenerate registry. Commit directly to main.
4. Append a JOURNAL entry (procedure F) **only if** the outcome changes what
   the other operator should run next; otherwise the experiment.md suffices.

### E. Regenerate REGISTRY.md

Rebuild the whole file from the front matter of every
`lab/experiments/*/experiment.md`, sorted by id. Never edit it directly, and
never let it disagree with front matter. Format:

```markdown
# Experiment Registry

Generated from experiment front matter — do not edit by hand.

| id | owner | status | benchmark | claim | budget | spent |
|----|-------|--------|-----------|-------|--------|-------|
| e001-... | ana | analyzed | swebench_verified | ... | $200 | $187 |
```

### F. JOURNAL.md

Append-only, newest entry first, directly under the title. Entries are for
things that affect the *other* operator: a new claim worth flagging, a result
that changes shared plans, budget events, infrastructure changes. Not a diary.

```markdown
## 2026-07-12 — ben (via agent)
e004 analyzed: panel size 3 matches size 5 within CI at 40% cost.
Suggest the topology axis (claimed by nobody) before any more panel work.
```

Max 10 lines per entry. Never edit or delete an existing entry.

## Hard rules

1. Never rewrite merged git history in `lab/`.
2. Never edit another operator's `experiment.md`. Questions or disagreements
   go in JOURNAL.md or the proposal PR.
3. Never run a sweep for an experiment whose proposal PR is unmerged.
4. Never exceed `budget_usd`; always pass `--spend-ceiling-usd` at plan time.
5. Never commit anything under `work/`, result payloads, or secrets.
6. `sweep_id` always equals the experiment id — this is what makes Grafana's
   `run_id` label and Athena's `sweep_id` partition map 1:1 to registry rows.
7. When in doubt about overlap, do not silently proceed: report to your
   operator with the conflicting experiment id.
