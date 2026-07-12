---
name: hypergrid-hillclimb
description: >-
  Supervise a hyperkit hypergrid search that hill-climbs FusionKit's open-weight
  compound toward closed-frontier SOTA on a locked holdout. Use when asked to
  "run the hypergrid", "supervise the hill climb", "find the best open-weight
  compound", "close the gap to SOTA", "extend the hypergrid", or to resume a
  paused hypergrid run. Drives per-generation loops (apply -> collect ->
  supervisor.py -> prune/broaden -> extend), delegates log-heavy reading to
  minion subagents, and enforces budget + locked-split iron laws.
---

# Hypergrid Hill-Climb (supervision loop)

Find the hyperpoint — kernel x panel x hyperparams x prompts, open-weight
models only — that gets closest to the frozen SOTA anchors. Run from repo
root. The plan of record is `analysis/hypergrid/PLAN.md`; the current run's
artifacts live in `analysis/hypergrid/<run-id>/`.

## Iron laws

1. Wins are claimed ONLY on the locked holdout (`manifests/holdout.txt`),
   evaluated once per final incumbent. Dev results are navigation, not claims.
2. Closed models (anchors) never appear inside a fused cell, a panel, a judge,
   a synthesizer, or the prompt-tuning loop. `build_serve_config` enforces
   this; never bypass it.
3. Anchors are frozen: run once per split, never re-tuned, reused for every
   generation's gap computation.
4. Every generation ends with: ledger updated, artifacts + report committed
   and pushed, PR updated.
5. Budget gates are hard. Check `supervisor.py` total spend before every
   apply; the locked-final reserve ($60) is inviolable.
6. Fix-forward on infrastructure failures, but never re-bill what a log read
   can explain: run forensics minions before re-running any billed shard.

## The loop (one generation)

```
- [ ] 0. Re-read the self-prompt (below) + previous generation's report
- [ ] 1. uv run hyperkit apply --workdir .hyperkit/<sweep> --backend local [--only GLOB] [--rung N]
         (in tmux; HYPERKIT_LOCAL_MAX_WORKERS=8-12; local-controller session feeds Grafana)
- [ ] 2. Await completion (hyperkit status); watch Grafana + error shards while waiting
- [ ] 3. uv run hyperkit collect --workdir .hyperkit/<sweep>
- [ ] 4. uv run python analysis/hypergrid/supervisor.py --workdir .hyperkit/<sweep> --json <run-dir>/genN.json
- [ ] 5. Fan out minions (see Delegation): forensics on every FORENSICS flag,
         autopsies when the direction test fires, report draft
- [ ] 6. Decide: prune / broaden / promote / escalate (rules in reference.md)
- [ ] 7. Edit the experiment file to add the next generation's cells
- [ ] 8. uv run hyperkit extend <experiment.py> --workdir .hyperkit/<sweep>
- [ ] 9. Commit ledger + report + spec; push; update PR
```

## Self-prompt (re-read at the top of EVERY generation)

> I am the supervising scientist. My objective is the smallest paired gap to
> the SOTA anchors on the locked holdout, using open-weight compounds only.
> Before spending: What rung of the success ladder am I on? What did the last
> generation's direction test attribute the gap to — panel ceiling, selection
> regret, or synthesis damage? Which single axis does that attribution tell me
> to expand, and what is the cheapest cell that tests it? How much budget
> remains above the locked-final reserve? Am I about to re-derive something a
> minion or the supervisor table already established? If a cell family has
> been flat for two generations, why am I not pruning it?

## Delegation (minions)

Token-heavy reading goes to `gpt-5.6-sol-high` subagents, in parallel, as many
as needed. Minions never edit the experiment spec, never spend budget, never
make accept/reject decisions. Prompt templates in
[reference.md](reference.md#minion-prompts). Standing triggers:

- **Forensics** — any cell flagged `FORENSICS:high-error-count` or with a
  surprising rate: minion reads shard `raw` payloads + `fusionkit-serve.log`s,
  returns a categorized failure table (provider / timeout / truncation /
  extraction / genuinely wrong).
- **Autopsy** — direction test blames selection regret or synthesis damage:
  minion reads discordant transcripts (fused lost where solo won, and the
  reverse), returns a failure taxonomy + candidate prompt/kernel changes.
- **Literature scan** — before adding a reserve axis: minion surveys the
  method family, returns 2-3 concrete parameterizations as cell specs.
- **Report draft** — per-generation report.md from ledger + supervisor JSON +
  forensics verdicts.

## Stopping

Stop and write the final report when any of: (a) a fused cell's locked-holdout
result confirms the highest reachable ladder rung (fused >= anchor McNemar-
significant; or parity band; or fused > best-solo-open, p < 0.05); (b) budget
is spent to the reserve; (c) two consecutive generations moved no frontier
cell. The final evaluation runs the incumbent + best solo open + both anchors
once on `manifests/holdout.txt` and names the winning hyperpoint with its
committed runnable config.

## Operational notes

- Sweeps, controller, and tunnels run in tmux sessions (`gen0-screen`,
  `local-controller`, `grafana-tunnel`); cloud Grafana is the EC2 instance
  tagged `hypergrid-obs` (redeploy: `infra/hypergrid-obs/deploy.py`).
- Successive halving: `apply --rung 25|60|110` with `--only` per cell family;
  dataset_hash is pinned to the full dev manifest so promotion only runs new
  instances.
- Fused cells: set `attempts: 1-2` and `request_timeout_s: 1800` in cell
  params — multi-stage pipelines are slow and re-billing timeouts is waste.
- Costs: `ShardResult.cost_usd` is exact for OpenRouter solo cells; fused
  serve cells meter tokens only — estimate their cost from tokens x registry
  prices in the ledger.
