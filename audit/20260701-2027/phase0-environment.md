# Phase 0 — Environment setup

- run-id: `20260701-2027`
- date: 2026-07-01 (UTC)
- git SHA at start: `85257b86f2781d9744fcef8448788ae3a5a1eef0`
- branch: `cursor/fusion-production-audit-c70f`
- host: linux/x64 (Cursor Cloud Agent VM)
- node: v22.22.2 (nvm) — satisfies undici >= 22.19 floor
- pnpm: 10.33.4
- uv: 0.11.26
- docker: **not installed** → Docker-dependent suites (SWE-bench Pro, Terminal-Bench) OUT OF SCOPE for this audit.

## Key verification (smoke, ~$0.001)

- `OPENAI_API_KEY`: valid — `gpt-5.5` resolved to `gpt-5.5-2026-04-23`, returned "OK" (12 tokens).
- `ANTHROPIC_API_KEY`: valid — `claude-opus-4-8` returned "OK" (14 tokens).
- `GEMINI_API_KEY`: not set — correct; Google is out of scope by product decision.

## Sanity gates

- `pnpm verify` (check + build + test): **green** (58/58 node tests pass, exit 0).
- `uv run pytest tests -q`: **green** (296 tests pass).
- `node packages/cli/dist/index.js doctor`: reports both provider keys OK, engine
  fusionkit@0.8.0 provisioned, "ready". (Known issue: doctor exits 0/"ready" even
  though the committed `.fusionkit/fusion.json` panel includes a local MLX member
  that cannot run on linux — tracked for the report.)
- Fused round-trip through the shipped path: `uv run fusionkit serve -c
  configs/benchmark-panel.gpt-opus.yaml` on 127.0.0.1:8080, POST
  `/v1/chat/completions` with model `fusionkit/panel` → synthesized answer
  returned (panel fanout GPT-5.5 + Opus 4.8 + judge + synth), no errors.

## Panel base config

`configs/benchmark-panel.gpt-opus.yaml` — endpoints `gpt` (openai/gpt-5.5) and
`opus` (anthropic/claude-opus-4-8), judge=gpt, synthesizer=gpt, mode=panel,
temperature 0.2, max_tokens 4096. Snapshot: `panel-config-baseline.yaml` in this
directory.
