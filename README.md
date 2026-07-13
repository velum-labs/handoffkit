# FusionKit

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![npm: @fusionkit/cli](https://img.shields.io/npm/v/@fusionkit/cli.svg)](https://www.npmjs.com/package/@fusionkit/cli)
[![PyPI: fusionkit](https://img.shields.io/pypi/v/fusionkit.svg)](https://pypi.org/project/fusionkit/)

FusionKit fuses a panel of models - including open-weight models at a fraction of frontier prices - behind your unmodified coding agent. A single turn fans out to the panel, captures candidate trajectories, runs judge + synthesis, and returns one native Codex / Claude Code / Cursor response; the harness never knows fusion happened.

> **Canonical docs:** user-facing docs live at [fusionkit.velum-labs.com/docs](https://fusionkit.velum-labs.com/docs). Maintainer docs live in [`docs/`](docs), and the docs site source is [`apps/docs`](apps/docs).

## Install + quickstart

```bash
npm install -g @fusionkit/cli
fusionkit setup                      # one-time: warm the Python fusion engine
cd your-git-repo                     # FusionKit runs over the current git repo
fusionkit doctor                     # verifies uv, agent CLIs, keys, PATH, and platform
fusionkit codex                      # or: fusionkit claude | fusionkit cursor | fusionkit serve
```

For the built-in cloud trio, export any subset of `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `GEMINI_API_KEY`; missing members are skipped with a clear note. This repo's committed `.fusionkit/fusion.json` is different: it routes the panel through OpenRouter (`moonshotai/kimi-k2-thinking` + `qwen/qwen3-coder`), so set `OPENROUTER_API_KEY` here or run `fusionkit init` in your own repo to choose your panel.

Start here:

- [Installation](https://fusionkit.velum-labs.com/docs/getting-started/installation)
- [Quickstart](https://fusionkit.velum-labs.com/docs/getting-started/quickstart)
- [Configuration](https://fusionkit.velum-labs.com/docs/getting-started/configuration)
- [CLI reference](https://fusionkit.velum-labs.com/docs/cli/commands)
- [Privacy and data handling](https://fusionkit.velum-labs.com/docs/privacy)

## Why fusion

The thesis is economic as much as architectural: several cheaper or open-weight models can explore a repo in parallel, disagree, and let a stronger judge/synthesizer turn their work into one answer. FusionKit gives you the mechanism - panel fanout, per-model worktrees, judge synthesis, cost metering, and budgets - without forcing a new harness or provider. We are not publishing benchmark numbers yet; reproduce the methodology yourself with [`docs/benchmarking-runbook.md`](docs/benchmarking-runbook.md) and [`docs/public-benchmark-comparison.md`](docs/public-benchmark-comparison.md).

## What's implemented

| Feature | What it gives you | Docs |
| --- | --- | --- |
| Fused coding harnesses | `fusionkit codex`, `claude`, and `cursor` launch normal agents against a local fusion gateway. | [quickstart](https://fusionkit.velum-labs.com/docs/getting-started/quickstart) |
| Raw inference endpoint | `fusionkit serve` exposes OpenAI-compatible chat completions backed by the same panel + synthesis engine. | [endpoint](https://fusionkit.velum-labs.com/docs/getting-started/inference-endpoint) |
| Streaming + tool calling | OpenAI Responses, Anthropic Messages, and OpenAI Chat dialects stay native at the harness edge. | [model fusion](https://fusionkit.velum-labs.com/docs/concepts/model-fusion) |
| Named ensembles | `.fusionkit/fusion.json` can define multiple panels; each becomes its own `fusion-<name>` model id. | [configuration](https://fusionkit.velum-labs.com/docs/getting-started/configuration) |
| Rate-limit handoff | Default `onRateLimit: fusion` re-runs a failed passthrough turn on the panel instead of returning a raw 429. | [handoff](https://fusionkit.velum-labs.com/docs/getting-started/rate-limit-handoff) |
| Durable sessions | Full turns, metadata, and costs persist locally for `sessions`, `--resume`, and `--continue`. | [privacy](https://fusionkit.velum-labs.com/docs/privacy) |
| Cost controls | Per-turn token/USD estimates, receipts, and `--budget <usd>` keep spend visible. | [costs](https://fusionkit.velum-labs.com/docs/cli/cost-and-models) |
| Local MLX path | `--local` runs an Apple-Silicon MLX panel with no provider API spend. | [models](https://fusionkit.velum-labs.com/docs/cli/models-and-panels) |

## CLI surface

| Command | Purpose |
| --- | --- |
| `codex` / `claude` / `cursor` / `serve` | Main journey: run a fused panel behind a coding harness, or run just the gateway. |
| `setup` | Pre-provision the pinned PyPI `fusionkit` engine into the `uvx` cache. |
| `doctor` | Preflight readiness; exits nonzero only when not ready (no `uv`/`uvx`, or no credentials and no downloaded local MLX model). |
| `init` | Scaffold `.fusionkit/fusion.json` and editable prompt files for a repo. |
| `config` | `show` (effective config + run preview), `path`, `get`, `set`, `unset`, `edit`, and `export-yaml`. |
| `prompts` | `list`, `edit`, and `reset` judge/synthesizer prompt overrides. |
| `ensemble` | `list`, `add`, `edit`, `remove`, and `rename` named ensembles. |
| `sessions`, `models` | Manage durable sessions and the local MLX model cache; launcher `--direct` mode handles single-local-model runs. |
| `stop` | Stop all background fusion services (router, dashboard, subscription proxy, ...). |
| `install <tool>` / `uninstall <tool>` | Register FusionKit inside a tool's own config (currently `codex`: extra provider + one profile per ensemble). |
| `proxy` | `serve`, `add`, `status`, and `stop` for the Claude Code / Codex subscription pooling relay. |
| `telemetry` | `status`, `on`, `off`, and `inspect` for opt-in, anonymous product telemetry. |
| `completion <shell>`, `version` | Shell completions and version reporting. |

## Architecture

Two processes cooperate:

1. **Node `@fusionkit/cli`** owns the user journey: config, preflight, harness launchers, the local gateway, sessions, cost controls, and local model management.
2. **Python `fusionkit`** owns the router and fusion engine: `/v1/chat/completions`, panel calls, judge synthesis, native run records, and benchmark tooling.

Panel members run in lightweight git worktrees so parallel candidates can inspect or edit the same repo without trampling each other. The gateway reshapes the fused result back into the dialect your harness already expects. Maintainer architecture details live in [`docs/fusion-harness-gateway.md`](docs/fusion-harness-gateway.md) and [`docs/fusion-judge-trajectory.md`](docs/fusion-judge-trajectory.md).

## Repository layout

| Area | What it is |
| --- | --- |
| [`packages/cli`](packages/cli) | The npm `@fusionkit/cli` front door. |
| [`packages/model-gateway`](packages/model-gateway) | Dialect translation, fused/passthrough routing, streaming, sessions, and cost metering. |
| [`packages/ensemble`](packages/ensemble) | Panel orchestration, worktrees, runtime-kernel workflows, judge adapters, and advanced harness tooling. |
| [`packages/tool-*`](packages) + [`packages/tools`](packages/tools) | Per-harness launchers and the shared tool integration registry. |
| [`packages/protocol`](packages/protocol) | Model-fusion contracts, schemas, traces, and generated bindings. |
| [`packages/adapter-ai-sdk`](packages/adapter-ai-sdk) | Managed MLX server and AI SDK model adapters used by local-model paths. |
| [`python/fusionkit-*`](python) | Python router, core fusion engine, CLI, MLX helpers, and eval tooling. |
| [`apps/docs`](apps/docs) | Canonical Fumadocs user site. |
| [`legacy/`](legacy) | Quarantined Warrant governance / VM-isolation stack; see [`legacy/README.md`](legacy/README.md) and [`docs/scope.md`](docs/scope.md). |

## Development

Prerequisites: Node >= 22.19.0 (`.npmrc` sets `engine-strict`, and the pinned `undici` requires it), pnpm, git, and uv. The repo pins pnpm in `packageManager`.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test
```

Python workspace commands:

```bash
uv sync --all-packages
uv run ruff check .
uv run pyright
uv run pytest tests -q
uv run pytest python -q
```

Link the local dev CLI without replacing the published `fusionkit` binary:

```bash
pnpm dev:link-cli
cd any-git-repo
fusionkit-dev doctor
fusionkit-dev codex
```

## Dependency policy

Third-party dependencies are allowed, but trusted versions are exact-pinned against the allowlist in [`scripts/check-repo.mjs`](scripts/check-repo.mjs). The `.npmrc` supply-chain controls (`engine-strict`, `ignore-scripts`, store verification, frozen installs, exact saves, and minimum release age) are part of the security posture.

## Legacy

The legacy Warrant governance plane, runner, SDK, handoff SDK, Docker stack, and VM/session packages are preserved under [`legacy/`](legacy). They are not invoked by the shipped `fusionkit` command tree and are documented separately in [`legacy/docs/`](legacy/docs).
