# Ensemble cost-frontier campaign (2026-07)

Research plan for the next Hyperkit benchmarking campaign: find (architecture x
panel) combinations of **cheap models** that beat the best cheap solo model on
quality-per-dollar. Synthesized from three research passes (architectures,
model roster, experiment design) grounded in the full experimental record on
`cursor/k1-official-harness-experiments-e24a`.

Frontier models (Fable 5, Claude Opus 4.8, GPT-5.5, Gemini 3 Pro tier) are
**excluded as ensemble members, judges, and synthesizers**; they may appear
only as reference baselines.

## 1. What the record already tells us

| Finding | Source | Consequence |
|---|---|---|
| Per-step trajectory fusion with a quality-gapped panel loses to its best member (16-18/30 vs 19-20/30, two fresh slices) | k1-swebench rounds 2A'/3 | "Route, don't fuse" for gapped panels; never carry a dead-weight member (qwen3-coder: 7/30 empty patches) |
| Judge-select-best on single-shot candidates **beat** the best member (38.6% vs 28.1%) | phase0 C3 transfer pilot | Selection over complete artifacts works; selection over per-step fragments does not |
| Execution-guided selection dominates (LCB 0.593 vs 0.477, McNemar 10-0); blind judge fusion regressed on polyglot | MOA_DESIGN internal results | Execution evidence is the strongest code signal we have |
| 4 driver-only solves across slices that no member solved | k1 rounds 1-3 | Deliberation composition is real but needs a peer-quality panel |
| Cheap panels have +7 to +17pp oracle headroom (phi floors met) | phase0 C1 | Complementarity exists at the cheap tier; converting it is the whole game |
| Judge null rate 54-67% and verbatim compliance 22-29% are prompt-resistant | k1 round 2C | Enforce adoption mechanically (emit picked candidate's batch), not rhetorically |
| kimi-k2-thinking not measurable ≤64k; r1 / qwen3-235b-thinking truncate >25% at 32k; terminus valid at 32k for $0.14/60 tasks | seed-audit-32k, thinking-32k | Prefer non-thinking members; truncation-audit every new model before paneling |

## 2. Architecture candidates (ranked for quality-per-dollar)

1. **Execution-guided select / repair** — panel (or self-sample) generates
   candidates, public tests select, a repair pass converts near-misses.
   Runs on the existing `executionSelectRepairWorkflow` +
   `lcb_select_adapter`. Cost ~3-8x a cheap member; strongest prior signal in
   our record (S*, PerfCodeGen corroborate). Kill: repair fixes <15% of
   public-test failures or breaks >5% of passing candidates.
2. **Cheap router cascade** — a cheap router (or logprob/self-consistency
   confidence signal) picks ONE model per task; escalate only on predicted
   failure. The direct follow-through of the route-don't-fuse verdict; cost
   0.4-1.2x solo. Router simulations over existing captures are free.
   Kill: routed score < best member by >1pp or escalation >60%.
3. **Commit-point trajectory select** — members run independent agentic
   trajectories; select/synthesize only at patch/commit checkpoints instead of
   every step (k >> 1). Keeps the driver-only-solve upside while deleting the
   per-step judge tax and null-pick pathology. Needs a checkpoint-capture
   operator (prototype in the Python engine first). Cost ~2-3.5x. Kill: no
   gain over best single trajectory or judge null >20%.
4. **Self-MoA / best-of-N on the best cheap model** — sample the single best
   cheap model N=3-5 with temperature diversity, select by execution or cheap
   judge. Removes cross-model quality gaps entirely (Self-MoA,
   arXiv:2502.00674). Runs on `BestOfNScheduler`. Cost ~N x one member.
   Kill: no pass@1 gain over n=1 or <0.5pp per extra sample.
5. **Adaptive test tournament** — a cheap model synthesizes *distinguishing*
   test inputs between rival candidates; execution arbitrates (S*-style).
   New `adaptive-input-synthesis` operator feeding execution-select. Cost
   ~3-6x. Kill: synthetic tests fail to distinguish on >50% of pairs.
6. (Deferred) peer-quality micro-MoA re-run of panel-judge-synth, multi-verifier
   committees, speculative collaborative decoding — run only if 1-5 leave
   budget, or as Phase B arms for promoted panels.

## 3. Model roster and panels (prices need re-verification at run time)

Roster of measurable cheap models (all ≤ ~$0.7/M in, ≤ ~$3.4/M out via
OpenRouter as of 2026-07; truncation-audit anything new before paneling):
`deepseek/deepseek-v3.1-terminus` (validated workhorse),
`deepseek/deepseek-v4-flash` (audit first), `minimax/minimax-m3`,
`qwen/qwen3.6-plus`, `moonshotai/kimi-k2.6`, `moonshotai/kimi-k2-0905`,
`z-ai/glm-5`, `z-ai/glm-4.6`, `google/gemini-3-flash-preview`,
`google/gemini-2.5-flash`, `openai/gpt-5-mini`, `qwen/qwen3-235b-a22b-2507`,
`mistralai/codestral-2508`, `meta-llama/llama-4-maverick`.

Lineage veto: no two members from one family; judge external to member
lineages when possible.

| ID | Panel | Judge/selector | ~$/30 SWE inst | ~$/60 alg tasks | Rationale |
|---|---|---|---:|---:|---|
| P7 | terminus + minimax-m3 | gemini-2.5-flash | $3.9 | $0.77 | Two-member peer panel; fewest drag paths; highest confidence per dollar |
| P3 | terminus + qwen3.6-plus + minimax-m3 | gemini-3-flash | $6.2 | $1.25 | Validated workhorse + two current peers |
| P4 | deepseek-v4-flash + kimi-k2.6 + gemini-3-flash | gpt-5-mini | $8.1 | $1.58 | Highest public-benchmark upside; **gated on truncation audit** |
| P1 | terminus + kimi-k2-0905 + qwen3-235b | gemini-2.5-flash | $6.0 | $1.13 | Cheapest lane matching known public complementarity |
| SE1 | terminus, N=5 self-sample | gemini-2.5-flash / gpt-5-mini | $8.2 | $1.46 | Self-MoA control arm |
| SE2 | deepseek-v4-flash, N=5 self-sample | gpt-5-mini | $2.7 | $0.50 | Ultra-cheap upside, audit first |

Judge ranking: `gpt-5-mini` > `gemini-2.5-flash` (reasoning capped) >
`gemini-3-flash-preview` > `terminus` (only for DeepSeek-free panels) >
`glm` > `qwen3-235b` (alg slices only).

## 4. Phased sweep plan (Hyperkit)

Statistical reality first: at p≈0.5 the Wilson 95% half-width is ~16.8pp at
n=30, ~8.8pp at n=120, ~5.6pp at n=300. McNemar 80% power for +5pp needs
~500+ paired tasks. n=30 confirms only large (+15pp) effects — screen wide
and cheap, confirm narrow.

### Phase A — screening (≤ $60, single-shot algorithmic + replay)

- 120-task LiveCodeBench-style slice (two 60-task seeds), plus free
  **replay rows**: judge-variant / router-threshold / no-synth selection
  simulations over existing captures (no new member calls).
- Grid: solo baselines for every roster model x panels {P7, P3, P1, P4-if-audited}
  x architectures {exec-select, exec-select-repair, judge-select, self-BoN
  (SE1/SE2), router-sim}. ~25-30 cells, most under $2 each.
- **Promotion criteria**: oracle headroom ≥5pp AND capture ≥25-30% AND point
  uplift ≥3pp over best cheap solo AND projected cost-per-solve ≤2x solo AND
  judge null <35%.

### Phase B — agentic dev iteration (≤ $150)

- SWE-bench Verified dev slice n=10-15 + Terminal-Bench subset n=6-10, for the
  2-4 promoted combos. Arms: per-step fusion (control), commit-point select,
  route-first/escalate. k=1 default.
- Ops: fused shards w=1, 32GiB (SWE) / 48-64GiB (Terminal) Batch memory
  reservation; abort on OOM >3% or infra failures >10%.
- Config-only iteration; source changes only for measured harness/parse/memory
  defects, with dev-cell reruns. Never touch confirmation manifests.
- Promote on positive paired uplift across both benchmark families (or one
  strong win, no regression), capture ≥25%, cost ≤2x solo or Pareto-dominant.

### Phase C — locked confirmation (≤ $120 reserve)

- Fresh disjoint n=30 manifest per benchmark, repo-stratified, one-shot run of
  the single best combo vs best cheap solo on the same manifest.
- Wilson + exact McNemar + clustered bootstrap. Success = uplift >0, p<0.05,
  cost ≤2x solo. If the point estimate is +8-10pp but p≥0.05, do not claim
  victory — roll the reserve into an n≈200 extension.

Budget roll-up: A ≤$60, B ≤$150, C ≤$120, reserve $40-170 → within $300-500.

## 5. Pre-registration checklist (per phase)

- Freeze `sweep.lock.json` before any billed call: benchmark version, manifest
  hash + seed + strata, model ids, config/prompt hashes, container image,
  symmetric-exclusion rule for grader errors.
- Record judge/synth lineage overlaps as limitations.
- Truncation-audit every new model (≤10% truncated at 32k, else 64k
  escalation, else exclude) before it may join a panel.
- Grafana watch list: pass@1 Wilson bands, best-single vs fused vs oracle,
  capture, cost-per-solve, judge null/parse rate, OOM/spot-retry burn.
- Abort a panel when: headroom <5pp, pairwise phi >0.7, capture ≤0 after 30-60
  paired tasks, or projected cost >2.5x solo without uplift.
