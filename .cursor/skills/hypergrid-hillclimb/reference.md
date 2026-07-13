# Hypergrid hill-climb — decision rules and templates

Companion to [SKILL.md](SKILL.md). All rules key on the supervisor table
(`analysis/hypergrid/supervisor.py`).

## Success ladder (locked holdout only)

1. **Rung 1:** fused open-weight > best solo open-weight, McNemar p < 0.05.
2. **Rung 2 (parity band):** anchor rate inside the fused cell's Wilson 95%
   interval AND fused-vs-anchor McNemar non-significant.
3. **Rung 3:** fused open-weight >= anchor, McNemar p < 0.05 (carry the
   contamination caveat from STARTING_POINT.md verbatim).

## Direction test (run every generation, pick ONE axis to expand)

Compute on the dev split with the supervisor table:

| Observation | Attribution | Next axis |
|---|---|---|
| best panel oracle (`oracle_private` or pair union) < anchor rate | Panel ceiling | Add/replace panel members (complementarity-ranked), raise N, add lineage-diverse family |
| oracle >= anchor but fused < oracle - 3pp | Selection regret | Better selection kernel: exec-select variants, tie-judge, judge model swap, judge prompt tier |
| judge-select cell > judge-synth cell on same panel | Synthesis damage | Flip `synthesis_select_best`, hybrid kernel (synthesize only when no candidate passes public tests) |
| fused ~= oracle ~= anchor band | Converged | Promote rung / go to holdout |

## Prune rules (retire the cell family, record in report)

- Wilson upper bound < best-solo-open Wilson lower bound on >= the same
  instances (`PRUNE:wilson-dominated-by-best-solo` flag).
- Pareto-dominated on (gap-to-SOTA, cost) by a sibling in the same kernel
  family at the same rung.
- Panel oracle headroom < 2pp over its best member (lopsided; Phase-0 lesson).
- Two consecutive generations without frontier movement for the family.

## Broaden rules (add neighbors, cheapest rung first)

- Cell within CI-overlap of the frontier: add adjacent N (3->5->8), adjacent
  temperature, kernel variant on the same panel, one panel swap chosen by
  union coverage (never by solo rank alone; respect the registry lineage veto).
- Oracle headroom crosses the anchor but fused lags: escalate the judge, not
  the panel — judge model swap first (strongest open model), then Tier-1
  prompt replay (`fusionkit fusion-hillclimb` with the OPEN panel config),
  re-inject winners as new cells.
- New kernel families enter at rung 25 and must beat the family median to be
  promoted to 60.

## Escalation ladder

config axes -> prompt axes (frozen-bank replay; accepted prompts committed to
`.fusionkit/prompts/` on the climb branch) -> gated source changes (one
focused change, `uv run pytest -q` green, revert on failed gates — same Tier-3
rules as the fusion-hillclimb skill).

## Budget discipline

- Budgets live in each lab experiment's front matter (`budget_usd`), passed as
  `--spend-ceiling-usd` at plan time. Guide rail across the campaign: screen
  <= $65, kernel probes + compound search <= $100 cumulative, locked-final
  reserve $60 (its own experiment; never touched before the final).
- The engine records but does not yet enforce the ceiling: before every
  `apply`, estimate = shards x per-shard cost from the last generation's
  metered `cost_usd` for that family; abort if estimate exceeds the remaining
  experiment budget.
- `supervisor.py` total spend is the running meter; `spent_usd` in front
  matter is set at conclusion (fused serve cells: tokens x registry prices).

## Minion prompts

**Forensics** (one minion per flagged cell):

> Read the ShardResult JSONs in `<results-dir>` whose cell_id is `<cell>` and
> any `fusionkit-serve.log` under `<workdir>/work/<cell>/`. Categorize every
> non-resolved shard as: provider-error / request-timeout / output-truncation
> (finish_reason=length) / code-extraction-failure / genuinely-wrong-answer /
> sandbox-or-grading-bug. Return a markdown table (instance, category,
> one-line evidence) plus counts, and flag anything suggesting OUR harness
> (not the model) is at fault. Do not modify any files.

**Autopsy** (selection regret / synthesis damage):

> For instances `<list>`, cell `<fused>` failed where `<baseline>` passed (or
> vice versa). Read both cells' ShardResult raw payloads (selected_code,
> samples, public/private test counts) in `<results-dir>`. For each instance
> say WHERE the pipeline lost it: generation (no sample passed public),
> selection (a passing sample existed but was not selected), synthesis
> (selected/rewritten output worse than best sample), or grading. Return a
> taxonomy table + up to 3 concrete, minimal prompt or kernel changes that
> would have flipped the most instances. Do not modify any files.

**Literature scan:**

> Survey current best practice for `<method family>` in LLM ensembling for
> code (papers + strong blog posts). Return 2-3 concrete parameterizations as
> hyperkit cell param dicts (n_samples, temps, selection, judge role), each
> with one sentence on why it should beat `<current frontier cell>`.

**Report draft:**

> Draft `analysis/hypergrid/<run-id>/genN-report.md` from: supervisor JSON
> `<path>`, ledger `<path>`, forensics verdicts pasted below. Sections:
> frontier table, direction-test attribution, decisions (prune/broaden with
> reasons), spend, next generation spec. Keep it under 120 lines, no
> hedging, numbers verbatim from the JSON.
