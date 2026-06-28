# CLI reference

The `fusionkit` CLI (`@fusionkit/cli`) is the single front door to the ensemble
product: it runs an ensemble of local + cloud models, both as a raw inference
endpoint and behind a coding harness (Codex, Claude Code, Cursor). It is
implemented in [`packages/cli`](../packages/cli); the command tree is wired in
[`packages/cli/src/cli.ts`](../packages/cli/src/cli.ts) (`buildProgram`).

Build the workspace before using the local binary:

```sh
pnpm build
fusionkit --help            # or: node packages/cli/dist/index.js --help
```

The Python synthesizer (`fusionkit serve`) is fetched from PyPI via `uvx`; only
`uv` and the coding-agent CLI you launch need to be installed locally. The pinned
engine is **auto-provisioned** on first use; pre-warm it with `fusionkit setup`
(or `fusionkit doctor --provision`) so the first real run is instant.

Task-focused walkthroughs: [inference endpoint](quickstart-inference.md),
[coding harness](quickstart-harness.md),
[rate-limit handoff](quickstart-handoff.md), and the
[model catalog](model-catalog.md).

## Quick tour

```sh
fusionkit setup                      # pre-provision (warm) the fusion engine into the uvx cache
fusionkit doctor                     # check prerequisites (uv, agents, keys, git, platform capability)
fusionkit init                       # scaffold a committed .fusionkit/ for this repo
fusionkit codex                      # run the ensemble behind Codex (or: claude | cursor | serve)
fusionkit serve                      # run the raw OpenAI/Anthropic-compatible ensemble endpoint
fusionkit config show                # the effective config + where each value came from
fusionkit sessions                   # list durable sessions you can --resume
```

## Command groups

| Command | Purpose | Source |
| --- | --- | --- |
| `codex` \| `claude` \| `cursor` \| `serve` | Run the model ensemble behind a coding harness (or `serve` to print raw-endpoint setup). The headline product path. | `packages/cli/src/commands/fusion.ts` |
| `fusion [tool]` | The generic launcher behind the per-tool shortcuts; omit the tool on a TTY to pick interactively. `fusion stop` reaps portless singleton services. | `packages/cli/src/commands/fusion.ts` |
| `init` | Scaffold a committed `.fusionkit/` folder (panel, judge, tool, prompts) for a repo. | `packages/cli/src/commands/fusion.ts` |
| `config` | Inspect the one config source of truth: `config show` / `config path` / `config export-yaml`. | `packages/cli/src/commands/config.ts` |
| `sessions` | List, inspect, and remove durable gateway sessions: `sessions [list]` / `sessions show <id>` / `sessions rm <id>`. | `packages/cli/src/commands/sessions.ts` |
| `models` | Manage the local MLX model cache: `models list` / `models download` / `models rm`. | `packages/cli/src/commands/models.ts` |
| `local <tool>` | Back a vendor agent (claude / codex / opencode / cursor) with a single local model — no fusion. | `packages/cli/src/commands/local.ts` |
| `ensemble` | Lower-level ensemble + harness tooling: `ensemble run` / `handoff` / `dashboard` / `e2e` / `gateway`. | `packages/cli/src/commands/ensemble.ts` |
| `setup` | Pre-provision (warm) the pinned `fusionkit` engine into the `uvx` cache; `--force` re-warms, `--fusionkit-dir` targets a local checkout. | `packages/cli/src/commands/setup.ts` |
| `doctor`, `status` | Preflight the environment (prerequisites, per-platform capability, engine-cached state) and preview the effective fusion config + run plan. `doctor --provision` also warms the engine. | `packages/cli/src/commands/doctor.ts` |

## The ensemble launchers (`codex` / `claude` / `cursor` / `serve`)

`fusionkit codex` (and its siblings) spawn the whole stack — the model panel, a
single `fusionkit serve` router that fronts each panel model and performs
synthesis, the harness gateway, and the chosen agent pre-wired to it — in one
command. fusionkit's own flags must precede the tool name; everything after the
tool is forwarded to it.

```sh
fusionkit codex --local                                 # local MLX trio (Apple Silicon)
fusionkit claude --repo /path/to/repo                   # fuse over another repo
fusionkit codex --model gpt=openai:gpt-5.5 --model opus=anthropic:claude-opus-4-8
fusionkit cursor --ide                                  # wire the Cursor IDE (no tunnel)
```

Shared flags (full list in `applyFusionOptions`):

| Flag | Meaning | Workstream |
| --- | --- | --- |
| `--model ID=MODEL` / `ID=PROVIDER:MODEL` | Panel member (repeatable). `--models` is an alias. | core |
| `--model-endpoint ID=URL` | Use a pre-running OpenAI-compatible endpoint as a panel member. | core |
| `--key-env ID=ENV` | Env var holding a model's API key. | core |
| `--judge-model MODEL` | Model used for judge synthesis. | core |
| `--local` / `--no-local` | Use the local MLX trio instead of the cloud panel. | core |
| `--observe` / `--no-observe` | Boot the local scope dashboard and stream trace events. | core |
| `--repo DIR` | The coding workspace the panel fuses over. | core |
| `--synthesis-url URL` / `--fusionkit-dir DIR` | Reuse a running `fusionkit serve`, or run a local FusionKit checkout (dev override). | core |
| `--port N` / `--portless` / `--no-portless` | Gateway port / portless stable URLs. | core |
| `--auth-token TOKEN` | Require a bearer token on the gateway. | core |
| `--yes` | Skip the interactive cloud-panel cost confirmation. | core |
| `--ide` | Cursor only: wire the Cursor IDE to the gateway via a local desktop proxy (no public tunnel). | WS6 |
| `--on-rate-limit fusion\|passthrough\|fail` | Vendor rate-limit / credit handoff policy (default `fusion`). | WS5 |
| `--budget USD` | Stop the session once it has spent this much (gateway-observed USD). | WS7 |
| `--resume ID` | Resume a stored session by id or unique prefix. | WS4 |
| `--continue` | Resume the most recently active stored session. | WS4 |

See [Fusion Harness Gateway](fusion-harness-gateway.md) for the per-harness wire
details and the streaming model, and [Configuration](configuration.md) for how
flags, `.fusionkit/fusion.json`, and built-in defaults compose.

## Durable sessions (`--resume` / `--continue`)

Gateway sessions are persisted under `~/.fusionkit/sessions/` (override with
`FUSIONKIT_SESSIONS_DIR`), keyed by session id, holding the conversation,
candidate cache, and per-turn cost. Resume one later:

```sh
fusionkit sessions                 # id, tool, panel, turn count, last activity, cost
fusionkit sessions show <id>       # header + the most recent turns
fusionkit codex --continue         # resume the most recently active session
fusionkit codex --resume 1a2b3c    # resume a specific session (unique prefix ok)
fusionkit sessions rm <id>         # delete a stored session
```

## Cost metering and budgets (`--budget`)

Every turn is metered (tokens + USD, from endpoint `pricing` metadata) and a
running session total is kept; `fusionkit sessions` shows it. `--budget <usd>`
caps a session: once the gateway-observed spend crosses the cap, the session
stops. See [Configuration](configuration.md) for setting `budgetUsd` and
`onRateLimit` as repo defaults.

## Configuration

`fusionkit` has one config source of truth — a committed `.fusionkit/` folder at
your repo root. Flags win over `.fusionkit/fusion.json`, which wins over built-in
defaults. Inspect and derive it:

```sh
fusionkit config show              # effective config + provenance (flag / .fusionkit / default)
fusionkit config path              # the .fusionkit/fusion.json location
fusionkit config export-yaml       # the derived `fusionkit serve` router YAML (raw endpoint)
```

The full model is documented in [Configuration](configuration.md).
