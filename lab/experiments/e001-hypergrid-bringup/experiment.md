---
id: e001-hypergrid-bringup
owner: alen
status: abandoned
benchmark: livecodebench
claim: "substrate bring-up and partial anchor/open-weight screen"
sweep_id: e001-hypergrid-bringup
budget_usd: 10
spent_usd: 5.10
created: 2026-07-12
updated: 2026-07-13
---

## Hypothesis
HyperKit can run a resumable LiveCodeBench screen with live observability and
produce paired anchor/open-weight evidence.

## Design
The archived grid had two closed anchors and 11 open-weight solo cells on the
110-task dev manifest, with anchors initially limited to rung 60.
It used the local parallel backend; the original specification is
`analysis/hypergrid/gen0.py`.

## Out of scope
Kernel comparison, compound search, and locked-holdout claims.

## Decision rule
Proceed only after engine, providers, benchmark data, and OTLP dashboards pass
preflight; abandon on an environment loss before the screen completes.

## Results
The run stopped at 165/1,430 shards with two errors and spent $5.10.
GPT-5.5 resolved 33/45: 73.3% [59.0%, 84.0%].
ds32 resolved 21/108: 19.4% [13.1%, 27.9%], with two errors.
dsv4pro resolved 5/10: 50.0% [23.7%, 76.3%].
These incomplete dev results are navigation only, not a claim.
Source: `analysis/hypergrid/20260712-0843/RETROSPECTIVE.md`.

## Decision
Abandoned after the local environment restart destroyed the ephemeral workdir;
re-register the complete screen as e002 on the deployed AWS Batch substrate.

## Follow-ups
- claimed: alen — e002 SOTA-anchor and open-weight solo screen
