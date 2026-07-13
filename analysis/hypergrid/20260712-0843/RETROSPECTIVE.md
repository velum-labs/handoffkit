# Hypergrid run 20260712-0843 — retrospective (stopped for env restart)

Stopped deliberately at 2026-07-12 09:00 UTC on user request, mid generation-0
screen. This documents what worked, what didn't, and everything the restart
environment needs. Total spend: **$5.10** ($0.01 smokes + $0.01 smoke sweep +
$5.08 gen-0 partial) of the $250 budget.

## State at stop

- Branch `cursor/hypergrid-hillclimb-667a`, PR #97 (all code + docs pushed).
- Gen-0 sweep: 165/1430 shards done (2 errors), lock + results in
  `.hyperkit/gen0/` (gitignored, LOST with this VM — by design, shards are
  cheap; the manifests + experiment code reproduce them).
- Partial frontier snapshot: `gen0-partial.json` in this directory.
- **Cloud Grafana stays up** (independent of this VM, that was its purpose):
  http://100.54.204.108/ — EC2 `i-0a60394050bfe47b7`, us-east-1, tag
  `hypergrid-obs`, ~$0.55/day. Prometheus basic-auth password + Grafana admin
  password are ONLY in `~/.hypergrid-obs.env` on the dead VM — **regenerate by
  terminating the instance and re-running `infra/hypergrid-obs/deploy.py`**
  from the new env (idempotent, ~6 min). Historic metrics are disposable.

## What worked (keep, all committed)

1. **Hyperkit as the search engine.** plan/apply/collect/extend, content-
   addressed shards, resume semantics — all behaved exactly as designed.
   Zero re-billed shards across restarts of the apply process.
2. **The substrate built this run** (all tested, ruff/pyright/pytest green):
   - `hyperkit/adapters/livecodebench.py` — Docker-free, kernel params
     (`n_samples/temps/selection/max_tokens/request_timeout_s/attempts`),
     exact OpenRouter cost metering via `usage: {include: true}`.
   - `run_instance(..., params)` seam — harness kernels as cell coordinates.
   - Parallel `LocalComputeBackend` (`HYPERKIT_LOCAL_MAX_WORKERS`) + per-shard
     SUT isolation + `apply --rung/--only` for successive halving.
   - `hyperkit local-controller` — filesystem twin of the cloud controller;
     production dashboards worked unchanged against local sweeps.
3. **Cloud observability recipe** (`infra/hypergrid-obs/deploy.py`): single
   EC2 + compose + basic-auth Prometheus OTLP ingest + anonymous-viewer
   Grafana; dashboard validator green (115 queries / 10 dashboards); verified
   401/200 auth split; snapshots ingested end-to-end.
4. **fusionkit-serve via inline `serve_config`** — booted reliably per shard
   (~2 s), panel + passthrough model ids served; fused smoke cell answered.
5. **Draft manifests + problem store**: 220-task dev/holdout/spare split
   (seeded, committed) + `build_lcb_store.py` (1.7 GB local store rebuilt from
   HF jsonl in ~15 s once shards are downloaded).
6. **Supervisor + skill**: `analysis/hypergrid/supervisor.py` (frontier table,
   gap-to-SOTA, McNemar, complementarity pairs, prune flags) and
   `.cursor/skills/hypergrid-hillclimb/` (loop, rules, minion prompts).
7. **Billed smokes + preflight gate** caught real issues before spend
   (gpt-5.5 rejects max_tokens<16; FusionConfig is flat, not nested).

## What didn't work (fix in the restart)

1. **Grafana telemetry gap (the "no data" report):** the sweep tmux session
   was started WITHOUT `OTEL_EXPORTER_OTLP_ENDPOINT`, so runner-level
   `hyperkit_shards_*` counters never reached Prometheus — Sweep Live/Fleet
   panels stayed empty. Only the controller's `hyperkit_cell_*` gauges
   flowed. FIX: export OTLP env in the SAME shell as `hyperkit apply` (the
   skill's operational notes now say this; consider baking OTLP env into
   `apply` startup or a wrapper script so it cannot be forgotten).
2. **Fused-shard request timeout:** judge+synth on a hard task exceeded the
   900 s client timeout and burned 3616 s across retries (smoke `abc390_g`).
   FIX shipped: `request_timeout_s`/`attempts` are kernel params — fused
   cells must set `attempts: 1-2`, `request_timeout_s: 1800`. Not yet
   defaulted into the probe specs; do that in the restart.
3. **Committed sweep workdir by accident** (`.hyperkit/smoke` landed in one
   commit before `.gitignore` was extended). Harmless but noisy — the
   `/.hyperkit/` ignore is now in place; keep run artifacts in
   `analysis/hypergrid/<run-id>/` only.
4. **Anchor cost variance vs estimate:** gpt-5.5 metered $4.72 for 45
   instances (~$0.105/task) vs the ~$0.19/task estimate — fine (under), but
   opus was never reached; the $65 gen-0 gate remains plausible.
5. **`uv`/node PATH friction in fresh shells** (documented in AGENTS.md):
   every tmux session needed `~/.local/bin` + nvm node on PATH. The restart
   env should bake these into `.bashrc` via the env-setup flow.
6. **Sandbox `.hyperkit` state is ephemeral.** Losing the VM loses partial
   sweeps. If restarts are expected, point `ResultStore` at a persisted
   volume or sync `results/` to S3 periodically (hyperkit's S3 store exists;
   a tiny `aws s3 sync` cron in the sweep session is the cheap version).

## Early scientific signal (dev split, partial, navigation only)

- anchor-gpt55: 73.3% [59%, 84%] on 45 instances (n=60 rung planned).
- solo-ds32 (near-complete, 108/110): **19.4%** [13%, 28%] — a ~54pp gap to
  the anchor for the cheapest open model; far worse than the 2025-01+ slice
  numbers in prior work. The ≥2024-08 window (81 hard / 29 medium in dev) is
  much harder than expected for open weights.
- solo-dsv4pro: 50% at n=10 — the newer open generation may land mid-gap.
- Implication for the restart: expect the plan's ">25pp floor gap" rule to
  fire unless dsv4pro/kimi2.6/qwen37max close most of the gap; be ready to
  (a) lean on multi-sample exec-select kernels rather than panel composition,
  and/or (b) reweight the dev slice toward medium difficulty.

## Restart runbook (new env) — superseded in part by the lab process

NOTE (2026-07-13): everything is merged to `main`, and the restart now runs
under the shared lab workflow (`lab/AGENTS.md` + the lab-process section of
`PLAN.md`): the screen re-registers as lab experiment e002 with
`--sweep-id <experiment id>` and a merged proposal PR before spend. Steps 1-4
below still apply verbatim.

1. Start from `main`; `uv sync --all-packages`;
   `pnpm install --frozen-lockfile && pnpm build` (node >= 22.19).
2. Download the 6 LCB jsonl shards (HF, ~4.3 GB, ~5 min) and run
   `uv run python analysis/hypergrid/build_lcb_store.py --jsonl-dir <dir>`.
3. Re-deploy observability: `uv run --with boto3 python
   infra/hypergrid-obs/deploy.py` (the old instance was destroyed; the
   Prometheus password is the SSM SecureString `/hypergrid-obs/prom-password`,
   fetched by consumers via `aws ssm get-parameter --with-decryption`; no
   local secrets file exists anymore).
4. Re-run the preflight (billed smokes ~ $0.02), commit `preflight.md`.
5. Register e002 per `lab/AGENTS.md` procedure A (proposal PR, wait for
   merge), then lock and run per procedure B with OTLP env set in the sweep
   shell; launch `hyperkit local-controller` alongside.
6. Resume the loop per `.cursor/skills/hypergrid-hillclimb/SKILL.md`.
   Completed-shard results from this run are lost; the ~$5 re-spend is
   accepted.

## Env-setup requirements for the new environment

uv (latest), node 22.22+ via nvm on login PATH, pnpm, Docker with the
Firecracker workarounds (only if local Grafana validation is wanted — the
cloud stack makes it optional), cloudflared (optional fallback tunnel),
`OPENROUTER_API_KEY` (mandatory; sole billing path used), `OPENAI_API_KEY` /
`ANTHROPIC_API_KEY` (optional — anchors run via OpenRouter), AWS credentials
with EC2/S3/SSM (observability redeploy only).
