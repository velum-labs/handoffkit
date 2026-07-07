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
fusionkit codex                      # run the ensemble behind Codex (or: claude | cursor | serve)
fusionkit init                       # scaffold a committed .fusionkit/ for this repo (interactive wizard)
fusionkit doctor                     # check prerequisites (uv, agents, keys, git, platform capability)
fusionkit serve                      # run the raw OpenAI/Anthropic-compatible ensemble endpoint
fusionkit config show                # the effective config + where each value came from
fusionkit config set budgetUsd 5     # edit any setting from the CLI (validated before writing)
fusionkit ensemble list              # the named ensembles (each its own fusion-<name> model)
fusionkit sessions                   # list durable sessions you can --resume
```

## Output contract

Every command renders its human UI on **stderr** (rich Ink rendering on an
interactive TTY; ordered plain lines in CI/pipes); **stdout** is reserved for
machine payloads. The global flags compose with every command:

| Flag | Meaning |
| --- | --- |
| `--json` | Emit a machine-readable JSON result on stdout (implies non-interactive). Errors become `{ "error": { "code", "message" } }`. |
| `--no-input` | Never prompt; prompts resolve to their defaults (the CI posture). |
| `--yes` | Accept confirmations (cost consent, destructive prompts) without asking. |
| `--quiet` | Suppress informational output; warnings and errors still print. |

Global flags precede the subcommand name (like every fusionkit flag);
informational commands also accept `--json` after the subcommand, e.g.
`fusionkit doctor --json`. `NO_COLOR`, `FORCE_COLOR`, and `FUSIONKIT_NO_TUI=1`
are honored, and piped answers still drive prompts
(`printf "2\n" | fusionkit init`).

## Command groups

| Command | Purpose | Source |
| --- | --- | --- |
| `codex` \| `claude` \| `cursor` \| `serve` | Run the model ensemble behind a coding harness (or `serve` to print raw-endpoint setup). The headline product path. | `packages/cli/src/commands/fusion.ts` |
| `fusion [tool]` | The generic launcher behind the per-tool shortcuts; omit the tool on a TTY to pick interactively. `fusion stop` reaps portless singleton services. | `packages/cli/src/commands/fusion.ts` |
| `init` | Scaffold a committed `.fusionkit/` folder (panel, judge, tool, prompts, extras, named ensembles) for a repo. | `packages/cli/src/commands/fusion.ts` |
| `setup` | Pre-provision (warm) the pinned `fusionkit` engine into the `uvx` cache; `--force` re-warms, `--fusionkit-dir` targets a local checkout. | `packages/cli/src/commands/setup.ts` |
| `doctor`, `status` | Preflight the environment (prerequisites, per-platform capability, engine-cached state) and preview the effective fusion config + run plan. `doctor --provision` also warms the engine. | `packages/cli/src/commands/doctor.ts` |
| `config` | Inspect **and edit** the one config source of truth: `config show` / `path` / `get` / `set` / `unset` / `edit` / `export-yaml`. | `packages/cli/src/commands/config.ts` |
| `prompts` | Manage the judge/synthesizer prompt overrides: `prompts list` / `prompts edit <id>` (opens `$EDITOR`, seeded from the engine default) / `prompts reset <id>`, with `--ensemble` for per-ensemble overrides. | `packages/cli/src/commands/prompts.ts` |
| `sessions` | List, inspect, and remove durable gateway sessions: `sessions [list]` / `sessions show <id>` / `sessions rm <id>`. | `packages/cli/src/commands/sessions.ts` |
| `models` | Manage the local MLX model cache: `models list` / `models download` / `models rm`. | `packages/cli/src/commands/models.ts` |
| `ensemble` | Manage named ensembles (`list` / `add` / `edit` / `remove` / `rename` / `use`) plus advanced maintainer harness tooling: `ensemble run` / `handoff` / `dashboard` / `e2e` / `gateway`. | `packages/cli/src/commands/ensemble.ts`, `ensemble-config.ts` |
| `local <tool>` | Back a vendor agent (claude / codex / opencode / cursor) with a single local MLX model and no fusion; for a fused local panel use `fusionkit codex --local`. | `packages/cli/src/commands/local.ts` |
| `telemetry` | Inspect and control anonymous, opt-in product telemetry: `telemetry status` / `on` / `off` / `inspect` (prints exactly what a session event would contain). Off by default; `DO_NOT_TRACK` beats everything. | `packages/cli/src/commands/telemetry.ts` |
| `completion <shell>` | Print a static shell completion script for bash, zsh, or fish (advanced). | `packages/cli/src/commands/completion.ts` |
| `runtime` | Advanced maintainer inspection of runtime-kernel workflows and composition primitives. | `packages/cli/src/commands/runtime.ts` |
| `version` | Print the npm CLI and pinned Python synthesizer version matrix. | `packages/cli/src/commands/version.ts` |

## The ensemble launchers (`codex` / `claude` / `cursor` / `serve`)

`fusionkit codex` (and its siblings) spawn the whole stack: the model panel, a
single `fusionkit serve` router that fronts each panel model and performs
synthesis, the harness gateway, and the chosen agent pre-wired to it in one
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
| `--model ID=MODEL` / `ID=PROVIDER:MODEL` | Panel member (repeatable; overrides the selected ensemble's panel). `--models` is an alias. | core |
| `--model-endpoint ID=URL` | Use a pre-running OpenAI-compatible endpoint as a panel member. | core |
| `--key-env ID=ENV` | Env var holding a model's API key. | core |
| `--ensemble NAME` | The session-default ensemble from `.fusionkit/fusion.json` (all defined ensembles still register as their own `fusion-<name>` models). | core |
| `--judge-model MODEL` | Model used for judge synthesis (applies to the selected ensemble). | core |
| `--local` / `--no-local` | Run the panel on local MLX models (Apple Silicon only) instead of cloud providers. | core |
| `--observe` / `--no-observe` | Boot the local scope dashboard and stream trace spans to it. | core |
| `--repo DIR` | The coding workspace the panel fuses over. | core |
| `--synthesis-url URL` / `--fusionkit-dir DIR` | Reuse a running `fusionkit serve`, or run a local FusionKit checkout (dev override). | core |
| `--port N` / `--portless` / `--no-portless` | Gateway port / portless stable URLs. | core |
| `--auth-token TOKEN` | Require a bearer token on the gateway. | core |
| `--yes` | Skip the interactive cloud-panel cost confirmation. | core |
| `--subagents` / `--no-subagents` | Auto-provision one native sub-agent per ensemble in the launched tool (default on): Codex roles, Claude `--agents`, `.cursor/agents/` scaffolds, opencode agents. | core |
| `--ide` | Cursor only: wire the Cursor IDE to the gateway via a local desktop proxy (no public tunnel). | WS6 |
| `--expose` | `serve` only: publish the gateway on a public HTTPS Quick Tunnel with a required (auto-generated) bearer token — for clients that cannot reach loopback, e.g. Cursor BYOK. | core |
| `--k N` | Step boundaries per panel member before aggregation (selected ensemble): 1 = single-completion proposers over the caller's exact messages+tools (tool calls become judged proposals), N > 1 = bounded managed lookahead (agent harness only), unset = full rollouts. | core |
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

`fusionkit` has one config source of truth: a committed `.fusionkit/` folder at
your repo root. Flags win over `.fusionkit/fusion.json`, which wins over built-in
defaults. The whole surface is editable from the CLI — no hand-editing needed:

```sh
fusionkit config show                          # effective config + provenance (flag / .fusionkit / default)
fusionkit config set budgetUsd 5               # set any value (dot paths; validated before writing)
fusionkit config set ensembles.default.judgeModel gpt-5.5
fusionkit config unset budgetUsd               # back to the built-in default
fusionkit config edit                          # interactive editor over every setting
fusionkit config path                          # the .fusionkit/fusion.json location
fusionkit config export-yaml                   # the derived `fusionkit serve` router YAML (raw endpoint)
```

Named ensembles are managed the same way:

```sh
fusionkit ensemble list                        # every ensemble + its fusion-<name> model id
fusionkit ensemble add fast                    # interactive panel builder (or --model/--judge flags)
fusionkit ensemble edit fast --add-model flash=google:gemini-2.5-flash
fusionkit ensemble use fast                    # make it the session default
fusionkit ensemble rename fast quick           # prompt overrides move with it
fusionkit ensemble remove quick
```

The full model is documented in [Configuration](configuration.md).

## Environment variables

| Variable | Meaning |
| --- | --- |
| `FUSIONKIT_DIR` | Local FusionKit checkout for the Python engine (`uv run --package fusionkit ...`). |
| `FUSIONKIT_NO_TUI` | Force plain output instead of the TUI. |
| `FUSIONKIT_SESSIONS_DIR` | Durable session store (default: `~/.fusionkit/sessions`). |
| `FUSIONKIT_CONSENT_PATH` | Cloud-panel cost consent file override (mostly tests/CI). |
| `FUSIONKIT_SKIP_KEY_VALIDATION` | Skip live provider-key validation when set to `1`. |
| `FUSIONKIT_TELEMETRY` | `1`/`0` overrides the stored product-telemetry consent for one invocation. |
| `DO_NOT_TRACK` | Any non-empty value force-disables product telemetry, beating every other setting. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Export fusion trace spans to your own OTLP/HTTP collector; `--observe` fills it with the local scope dashboard when unset. |
| `PORTLESS` | Set to `0` to disable portless routing by default. |
| `PORTLESS_STATE_DIR`, `PORTLESS_TLD` | Portless proxy state directory and local domain. |

Legacy `WARRANT_*` environment variables are no longer read; use `FUSIONKIT_*` in new scripts and docs.
