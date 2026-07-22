# FusionKit

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![npm: @routekit/cli](https://img.shields.io/npm/v/@routekit/cli.svg)](https://www.npmjs.com/package/@routekit/cli)
[![npm: @fusionkit/cli](https://img.shields.io/npm/v/@fusionkit/cli.svg)](https://www.npmjs.com/package/@fusionkit/cli)
[![PyPI: fusionkit](https://img.shields.io/pypi/v/fusionkit.svg)](https://pypi.org/project/fusionkit/)

FusionKit fuses a panel of models - including open-weight models at a fraction of frontier prices - behind your unmodified coding agent. A single turn fans out to the panel, captures candidate trajectories, runs judge + synthesis, and returns one native Codex / Claude Code / Cursor response; the harness never knows fusion happened.

The npm packages provide the user-facing `routekit` and `fusionkit` CLIs. The
PyPI `fusionkit` distribution is an internal sidecar runtime used by the Node
CLI; maintainer benchmarks use the separate `fusionkit-evals` distribution. It
does not install a user-facing Python `fusionkit` command.

> **Canonical docs:** user-facing docs live at [fusionkit.velum-labs.com/docs](https://fusionkit.velum-labs.com/docs). Maintainer docs live in [`docs/`](docs), and the docs site source is [`apps/docs`](apps/docs).

## Install + quickstart

For independent routing through explicit providers:

```bash
npm install -g @routekit/cli
routekit config init
routekit gateway serve              # or: routekit codex | claude | cursor
```

RouteKit has no FusionKit runtime dependency and does not download local models.

For model ensembles:

```bash
npm install -g @fusionkit/cli
fusionkit setup                      # one-time: warm the internal synthesis sidecar
cd your-git-repo                     # FusionKit runs over the current git repo
fusionkit init                       # scaffold Fusion v4 + RouteKit config
fusionkit doctor                     # verifies configs, live model IDs, uv, and agent CLIs
fusionkit codex                      # or: fusionkit claude | fusionkit cursor | fusionkit serve
```

Then enable providers in `.routekit/router.yaml`; FusionKit loads that file as
an explicit embedded RouteKit configuration and discovers source-qualified
`provider/model` IDs. The standalone RouteKit singleton does not discover it
by working directory; use `routekit config import --from .routekit/router.yaml`
to replace the singleton's canonical configuration when that is intended.
`.fusionkit/fusion.json` composes those IDs into ensembles. Every selected
model must be present in the live catalog.
This checkout's committed router uses OpenRouter
(`moonshotai/kimi-k2-thinking` + `qwen/qwen3-coder`) and therefore requires
`OPENROUTER_API_KEY`.

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
| Fused coding harnesses | `fusionkit codex`, `claude`, `cursor`, and `opencode` launch normal agents against a local fusion gateway. | [quickstart](https://fusionkit.velum-labs.com/docs/getting-started/quickstart) |
| Raw inference endpoint | `fusionkit serve` exposes OpenAI-compatible chat completions backed by the same panel + synthesis engine. | [endpoint](https://fusionkit.velum-labs.com/docs/getting-started/inference-endpoint) |
| Streaming + tool calling | OpenAI Responses, Anthropic Messages, and OpenAI Chat dialects stay native at the harness edge. | [model fusion](https://fusionkit.velum-labs.com/docs/concepts/model-fusion) |
| Named ensembles | `.fusionkit/fusion.json` v4 composes live namespaced RouteKit model IDs; each ensemble becomes its own `fusion-<name>` model id. | [configuration](https://fusionkit.velum-labs.com/docs/getting-started/configuration) |
| Rate-limit handoff | Default `onRateLimit: fusion` re-runs a failed passthrough turn on the panel instead of returning a raw 429. | [handoff](https://fusionkit.velum-labs.com/docs/getting-started/rate-limit-handoff) |
| Durable sessions | Full turns, metadata, and costs persist locally for `sessions`, `--resume`, and `--continue`. | [privacy](https://fusionkit.velum-labs.com/docs/privacy) |
| Cost controls | Per-turn token/USD estimates, receipts, and `--budget <usd>` keep spend visible. | [costs](https://fusionkit.velum-labs.com/docs/cli/cost-and-models) |
| RouteKit composition | Embedded or external RouteKit owns model routing and credentials; FusionKit owns ensembles and synthesis. | [configuration](https://fusionkit.velum-labs.com/docs/getting-started/configuration) |

## CLI surface

| Command | Purpose |
| --- | --- |
| `codex` / `claude` / `cursor` / `opencode` / `serve` | Main journey: run configured fusion ensembles behind a coding harness, or run just the gateway. |
| `setup` | Pre-provision the pinned PyPI `fusionkit` engine into the `uvx` cache. |
| `doctor` | Validate Fusion/RouteKit config, live model IDs, `uv`/`uvx`, git, and coding tools. |
| `init` | Scaffold `.fusionkit/fusion.json` v4 and a safe `.routekit/router.yaml` when absent. |
| `config` | `show`, `path`, `get`, `set`, `unset`, and `edit` Fusion-only settings. |
| `prompts` | `list`, `edit`, and `reset` judge/synthesizer prompt overrides. |
| `ensemble` | `list`, `add`, `edit`, `remove`, and `rename` named ensembles. |
| `sessions`, `models` | Manage durable Fusion sessions and the Fusion-owned local MLX cache. |
| `stop` | Stop only Fusion-owned processes and portless routes; external RouteKit daemons are untouched. |
| `telemetry` | `status`, `on`, `off`, and `inspect` for opt-in, anonymous product telemetry. |
| `completion <shell>`, `version` | Shell completions and version reporting. |

## Architecture

Three layers cooperate:

1. **RouteKit SDKs** own RouterConfig loading, live provider catalogs, model
   routing, provider credentials, multi-subscription pools, and the embedded
   router lifecycle.
2. **Node `@fusionkit/cli`** owns Fusion v4 config, ensembles, harness launchers, the Fusion gateway, sessions, and observability.
3. **Python `fusionkit-sidecar`** is internal. It receives completed trajectories
   and performs judge/synthesis calls through namespaced RouteKit model IDs; it
   does not implement providers or expose the public chat/model gateway.

Panel members run in lightweight git worktrees so parallel candidates can inspect or edit the same repo without trampling each other. The gateway reshapes the fused result back into the dialect your harness already expects. Maintainer architecture details live in [`docs/fusion-harness-gateway.md`](docs/fusion-harness-gateway.md) and [`docs/fusion-judge-trajectory.md`](docs/fusion-judge-trajectory.md).

## Repository layout

| Area | What it is |
| --- | --- |
| [`packages/routekit-cli`](packages/routekit-cli) | The independent npm `@routekit/cli` router front door. |
| [`packages/cli`](packages/cli) | The npm `@fusionkit/cli` front door. |
| [`packages/model-gateway`](packages/model-gateway) | RouteKit's neutral dialect translation, live provider catalog, namespaced dispatch, streaming, and per-call provenance/metering. |
| [`packages/fusion-gateway`](packages/fusion-gateway) | Fusion front door, panel/synthesis orchestration, durable sessions, and aggregate budgets. |
| [`packages/ensemble`](packages/ensemble) | Panel orchestration, worktrees, runtime-kernel workflows, judge adapters, and advanced harness tooling. |
| [`packages/tool-*`](packages) + [`packages/tools`](packages/tools) | Per-harness launchers and the shared tool integration registry. |
| [`packages/protocol`](packages/protocol) | Model-fusion contracts, schemas, traces, and generated bindings. |
| [`packages/adapter-ai-sdk`](packages/adapter-ai-sdk) | Managed MLX server and AI SDK model adapters used by local-model paths. |
| [`python/fusionkit-*`](python) | Internal synthesis sidecar and core, optional MLX helpers, testkit, and separately installed evaluation tooling. |
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

Link the local dev CLIs without replacing the published binaries:

```bash
pnpm dev:link-cli
pnpm dev:link-routekit
cd any-git-repo
fusionkit-dev doctor
fusionkit-dev codex
routekit-dev doctor
routekit-dev codex
```

## Dependency policy

Third-party dependencies are allowed, but trusted versions are exact-pinned against the allowlist in [`scripts/check-repo.mjs`](scripts/check-repo.mjs). The `.npmrc` supply-chain controls (`engine-strict`, `ignore-scripts`, store verification, frozen installs, exact saves, and minimum release age) are part of the security posture.

## Legacy

The legacy Warrant governance plane, runner, SDK, handoff SDK, Docker stack, and VM/session packages are preserved under [`legacy/`](legacy). They are not invoked by the shipped `fusionkit` command tree and are documented separately in [`legacy/docs/`](legacy/docs).
