# FusionKit

**Run ensembles of local and cloud models** for normal inference *and* behind
your coding agent.

FusionKit fans a single request out across a panel of models (local MLX, plus
OpenAI / Anthropic / Google / any OpenAI-compatible endpoint), runs each one,
and synthesizes the results into one answer. You can use it two ways:

- as a **raw inference endpoint** (`fusionkit serve`) that any OpenAI- or
  Anthropic-compatible client can point at, and
- as the **backend for an unmodified coding harness**: `fusionkit codex`,
  `fusionkit claude`, `fusionkit cursor` wire Codex, Claude Code, and Cursor to
  the ensemble over their own native wire protocols, so the tool never learns
  fusion happened.

The Node **`@fusionkit/cli`** is the single front door; the Python
**`fusionkit serve`** (PyPI `fusionkit`) is the documented raw endpoint it drives
under the hood.

> **Documentation:** the full user-facing docs live in the Fumadocs site under
> [`apps/docs`](apps/docs), published at `fusionkit.velum-labs.com`. This README
> is the product narrative and quick tour; the maintainer docs are in
> [`docs/`](docs).

## Install: one install story

```bash
pnpm add -g @fusionkit/cli           # or: npm i -g @fusionkit/cli  (installs the `fusionkit` command)
fusionkit setup                      # pre-provision the Python engine so the first run is instant
```

**Prerequisites:** [`uv`](https://docs.astral.sh/uv/) (ships `uvx`), `git`, and,
for the coding-harness path, the agent CLI you want (`codex` / `claude` /
`cursor-agent`). No separate Python install: the `fusionkit serve` synthesizer is
fetched from PyPI via `uvx` and **auto-provisioned**. `fusionkit setup` (or
`fusionkit doctor --provision`) warms that `uvx` environment up front so the
first real run doesn't pay a cold-start; without it, the engine provisions
on first use. Prefer not to install globally? Use `npx @fusionkit/cli <command>`.

## Quickstart: one command

Back a coding agent with a model ensemble:

```bash
export OPENAI_API_KEY=...  ANTHROPIC_API_KEY=...  GEMINI_API_KEY=...
cd your-git-repo
fusionkit codex                      # or: claude | cursor | serve   (add --local for an Apple-Silicon MLX panel)
```

Any subset of the three keys works: a default-panel member whose key is missing
is skipped with an explicit note, and the survivors are still fused.

`fusionkit codex` spawns everything for you: the model panel, a single
`fusionkit serve` router that fronts each model and performs synthesis, the
harness gateway, and Codex pre-wired to it. One `Ctrl+C` tears the whole stack
down. See the
[Fusion Harness Gateway](docs/fusion-harness-gateway.md#quickstart-one-command).

Run `fusionkit doctor` first to check prerequisites (uv, agents, provider keys,
git, and per-platform capability), and `fusionkit init` to scaffold a committed
`.fusionkit/` config for a repo.

### Quickstarts

- [Inference endpoint](docs/quickstart-inference.md): `fusionkit serve` as an
  OpenAI-compatible ensemble endpoint, with curl streaming + tool-calling.
- [Coding harness](docs/quickstart-harness.md): `fusionkit codex` / `claude` /
  `cursor` (+ `--ide`), the auto-wiring, and fused vs. passthrough models.
- [Rate-limit handoff](docs/quickstart-handoff.md): how `--on-rate-limit` works,
  what failover looks like, and one-tap resume.
- [Model catalog](docs/model-catalog.md): choosing/configuring panel models
  (cloud, open-weight, local MLX), pricing/`--budget`, decorrelated-trio guidance.

> **Cross-platform.** Cloud ensembles run on Linux, Windows, and macOS. Local MLX
> panels (`--local`) are Apple-Silicon-only; off Apple Silicon, `--local` fails
> early with a pointer at the cloud path. `fusionkit doctor` reports capability
> per platform.

## What's implemented

The ensemble loop is real end-to-end today, with these headline features:

| Feature | What it gives you | Docs |
| --- | --- | --- |
| **Streaming + tool calling through the ensemble** | Real SSE streaming and function/tool calls flow through the panel + judge, in each harness's native dialect (OpenAI Responses / Anthropic Messages / OpenAI Chat). | [gateway](docs/fusion-harness-gateway.md) |
| **Rate-limit / credit handoff** | When a vendor passthrough model hits a 429 / quota / billing error, the turn is transparently rerouted to the ensemble. `--on-rate-limit fusion\|passthrough\|fail`. | [cli](docs/cli.md), [config](docs/configuration.md) |
| **Durable, resumable sessions** | Sessions persist under `~/.fusionkit/sessions/`; resume with `--resume <id>` / `--continue`, inspect with `fusionkit sessions`. | [cli](docs/cli.md#durable-sessions---resume----continue) |
| **Cost metering + budgets** | Per-turn token + USD accounting, a running session total, and an optional `--budget <usd>` cap. | [cli](docs/cli.md#cost-metering-and-budgets---budget) |
| **Turnkey Cursor IDE** | `fusionkit cursor --ide` wires the Cursor IDE to the gateway through a local desktop proxy with no manual public tunnel. | [cli](docs/cli.md) |
| **One config source of truth** | A committed `.fusionkit/fusion.json` (+ `prompts/*.md`); the Python router YAML is *derived* from it via `fusionkit config export-yaml`. | [config](docs/configuration.md) |

## The CLI surface

| Command | What it does |
| --- | --- |
| `codex` \| `claude` \| `cursor` \| `serve` | Run the model ensemble behind a coding harness (or `serve` for the raw endpoint setup). |
| `fusion [tool]` | The generic launcher behind the shortcuts; `fusion stop` reaps portless services. |
| `init` | Scaffold a committed `.fusionkit/` for this repo. |
| `config` | `config show` / `config path` / `config export-yaml`. |
| `sessions` | `sessions [list]` / `sessions show <id>` / `sessions rm <id>`. |
| `models` | `models list` / `models download` / `models rm` (local MLX cache). |
| `local <tool>` | Back a vendor agent with a single local model (no fusion). |
| `ensemble` | Lower-level ensemble + gateway tooling (`run` / `handoff` / `dashboard` / `e2e` / `gateway`). |
| `setup` | Pre-provision (warm) the fusion engine into the `uvx` cache so the first run is instant. |
| `doctor`, `status` | Preflight the environment (incl. per-platform capability); preview the effective config and run plan. |

Full reference: [docs/cli.md](docs/cli.md).

## Architecture

Two cooperating processes:

1. **`fusionkit serve`** (Python, PyPI `fusionkit`): the model **router + fusion
   engine**: fronts every panel model by id (passthrough) and performs
   judge + synthesis (`/v1/fusion/trajectories:fuse`, `/v1/chat/completions`).
   This is the inference brain, and the documented raw endpoint.
2. **`@fusionkit/cli`** (Node): the **harness gateway + UX**: auto-wires
   Codex / Claude / Cursor, manages per-model git worktrees, spawns the Python
   router via `uvx`, and owns onboarding, config, sessions, and model management.

Each panel model runs the launched harness in its own lightweight git worktree
(parallel harnesses editing one repo, not VM isolation), producing a full
native **trajectory**; the synthesizer fuses those trajectories into one answer
in the request's natural shape. See
[Fusion Harness Gateway](docs/fusion-harness-gateway.md) and
[Fusion Judge Trajectory](docs/fusion-judge-trajectory.md).

## Repository layout (product packages)

| Package | What it is |
| --- | --- |
| [`@fusionkit/cli`](packages/cli) | The `fusionkit` CLI, the single front door and primary product surface. |
| [`@fusionkit/ensemble`](packages/ensemble) | The ensemble run engine: per-model worktrees, harness execution, judge synthesis, trajectory fusion. |
| [`@fusionkit/model-gateway`](packages/model-gateway) | The harness gateway: dialect translation (OpenAI Responses / Anthropic Messages / OpenAI Chat), streaming, durable session store, cost metering, rate-limit handoff. |
| [`@fusionkit/tools`](packages/tools) + [`tool-codex`](packages/tool-codex) / [`tool-claude`](packages/tool-claude) / [`tool-cursor`](packages/tool-cursor) / [`tool-opencode`](packages/tool-opencode) | The per-harness adapters that drive each vendor CLI. |
| [`@fusionkit/protocol`](packages/protocol) | The model-fusion data contracts (harness run request/result, trajectories) and generated SDK bindings. |
| [`@fusionkit/workspace`](packages/workspace) | Git workspace capture, worktree materialization, and divergence-safe pull. |
| [`@fusionkit/adapter-ai-sdk`](packages/adapter-ai-sdk) | The managed local-model stack (`mlxServer`) + AI SDK model adapters used by `fusionkit models`/`--local`. |

Several **governance / VM-isolation packages live under [`legacy/`](legacy)** but are
**not part of the ensemble product** (`plane`, `runner`, `sdk`, `handoff`,
`adapter-compute`, `session-hermetic`, `session-vercel-sandbox`,
`session-harness`). See **[docs/scope.md](docs/scope.md)** for the exact product
vs. out-of-scope mapping and remaining owner decisions.

## Python workspace

Alongside the pnpm workspace, the repository is a [uv](https://docs.astral.sh/uv/)
monorepo for its Python side (the root `pyproject.toml` declares a virtual
workspace under `python/*`):

```sh
uv sync --all-packages                 # one .venv for every Python package
uv run pytest python/uniroute/tests    # test a member
```

## Development

Prerequisites: Node >= 22 and git. The pnpm version is pinned via `packageManager`:

```sh
corepack enable          # one-time; activates the pinned pnpm
pnpm install             # links all workspace packages from the frozen lockfile
pnpm build               # tsc -b builds every package in dependency order
pnpm verify              # repo checks + build + the full test suite
```

To run this checkout's CLI globally while developing, link the dev command:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm dev:link-cli
fusionkit-dev --version
```

`fusionkit-dev` points at your local checkout, rebuilds the local CLI before each
run, and preserves the directory you launch it from. It does not replace the
published `fusionkit` command, so you can use it from any target repo:

```sh
cd any-git-repo
fusionkit-dev doctor
fusionkit-dev codex
```

For faster repeated local checks after a build, set
`FUSIONKIT_DEV_SKIP_BUILD=1`.

```sh
pnpm check               # repo invariants (required files, dependency pins, ...)
pnpm test                # the full unit + integration + example suite
pnpm demo all            # run every non-interactive example
```

## Dependency policy

Third-party dependencies are allowed in any package, but only trusted,
exact-pinned versions on the explicit allowlist in
[`scripts/check-repo.mjs`](scripts/check-repo.mjs). Trust comes from pinning
reviewed versions plus the `.npmrc` supply-chain controls (`save-exact`,
`ignore-scripts`, `verify-store-integrity`, frozen-lockfile installs, and a
24-hour `minimum-release-age`), not from the absence of dependencies. Bumping a
dependency means updating the allowlist pin, the review checkpoint.

## Out of product scope

These remain in the repository under [`legacy/`](legacy) and are still published
from it for now, but are
**not part of the FusionKit ensemble product**:

- **Governance plane**: `@fusionkit/plane`, `@fusionkit/runner`,
  `@fusionkit/sdk`, `@fusionkit/handoff` (contracts, receipts, policy,
  approvals, signed provenance).
- **VM / sandbox isolation**: `@fusionkit/session-hermetic`,
  `@fusionkit/session-vercel-sandbox`, `@fusionkit/session-harness`,
  `@fusionkit/adapter-compute`.

The shipped `fusionkit` command tree does not invoke them at runtime, and product
packages do not depend on them. The governed-execution design itself is
preserved in [`legacy/specs/`](legacy/specs).
