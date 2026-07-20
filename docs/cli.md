# CLI reference

## Product boundary

`@fusionkit/cli` installs only `fusionkit`. It composes the neutral
`@routekit/config`, `@routekit/router`, gateway, and tool-launcher SDK packages;
it does not depend on `@routekit/cli` or invoke the `routekit` executable.

Install `@routekit/cli` separately when you want RouteKit's provider, account,
live-catalog, proxy, or single-model command surfaces:

```sh
npm install -g @routekit/cli
routekit config init
routekit providers status
routekit models list
routekit gateway serve
routekit codex openai/gpt-5.5
```

FusionKit has no forwarding aliases for those commands.

## Fusion launchers

```sh
fusionkit codex [args...]
fusionkit claude [args...]
fusionkit cursor [args...]
fusionkit opencode [args...]
fusionkit serve
```

Every tool launcher receives the same neutral `ToolLaunchSpec`. Each configured
ensemble becomes a generic agent profile and a selectable `fusion-<name>` model;
the default ensemble keeps the `fusion-panel` ID.

Common Fusion flags:

| Flag | Meaning |
| --- | --- |
| `--ensemble <name>` | Session-default configured ensemble. |
| `--repo <dir>` | Coding workspace. |
| `--observe` / `--no-observe` | Start or skip the Fusion observability dashboard. |
| `--reasoning` / `--no-reasoning` | Show or suppress fusion progress reasoning. |
| `--subagents` / `--no-subagents` | Create or suppress one generic agent profile per ensemble. |
| `--port <n>` | Fusion gateway port. |
| `--portless` / `--no-portless` | Enable or disable Fusion-owned portless routes. |
| `--auth-token <token>` | Protect the Fusion gateway. |
| `--on-rate-limit fusion\|passthrough\|fail` | Rate-limit policy. |
| `--budget <usd>` | Session spend cap. |
| `--panel-trust full\|guarded` | Panel worktree policy. |
| `--k <n>` | Step boundaries per panel member. |
| `--resume <id>` / `--continue` | Resume a durable Fusion session. |
| `--ide` | Cursor desktop integration. |
| `--fusionkit-dir <dir>` | Local Python FusionKit checkout for development. |

There is no `--direct`, provider/model/key flag, or single-model mode. Use
RouteKit for single-model launches and edit `.routekit/router.yaml` for routing.

## Fusion commands

| Command | Purpose |
| --- | --- |
| `init` | Scaffold Fusion v4 config and, when absent, safe RouteKit router config. |
| `setup` | Warm the pinned Python synthesis engine. |
| `doctor` | Check git, Fusion/RouteKit config, live model IDs, uv, and tool binaries. |
| `config show\|path\|get\|set\|unset\|edit` | Inspect or atomically edit Fusion v4 settings. |
| `ensemble list\|add\|edit\|remove\|rename` | Manage ensembles of namespaced RouteKit model IDs. |
| `prompts list\|edit\|reset` | Manage judge/synthesizer prompt files. |
| `sessions list\|show\|rm` | Manage durable Fusion sessions in `@fusionkit/gateway`. |
| `models list\|download\|rm` | Manage the Fusion-owned local MLX cache. |
| `stop` | Stop only Fusion-owned processes and portless routes. |
| `telemetry status\|on\|off\|inspect` | Control opt-in Fusion telemetry. |
| `completion`, `version` | Shell completion and version information. |

`fusionkit stop` never stops an external RouteKit daemon. An embedded RouteKit
router is owned by the launching Fusion process and closes with that process.

Removed Fusion commands include `proxy`, account/CLIProxy management,
`install|uninstall codex`, and direct/single-model mode. Their equivalents live
in RouteKit.

## Configuration

```sh
fusionkit init
fusionkit config show
fusionkit ensemble add deep \
  --member openai/gpt-5.5 \
  --member anthropic/claude-sonnet-4-5 \
  --judge anthropic/claude-sonnet-4-5
fusionkit config set defaultEnsemble deep
```

`.fusionkit/fusion.json` v4 contains only fusion policy and namespaced model
IDs. Explicit providers and routing policy live in `.routekit/router.yaml`;
credentials remain in registry-defined environment variables or RouteKit's
private subscription store. See [Configuration](configuration.md).

## Environment variables

| Variable | Meaning |
| --- | --- |
| `FUSIONKIT_DIR` | Local Python engine checkout. |
| `FUSIONKIT_NO_TUI` | Force plain output. |
| `FUSIONKIT_SESSIONS_DIR` | Durable Fusion session directory. |
| `FUSIONKIT_CATALOG_PATH` | Local MLX catalog cache. |
| `FUSIONKIT_MLX_DIR` | Fusion-owned MLX runtime/model cache. |
| `FUSIONKIT_DASHBOARD_PORT` | Local dashboard port. |
| `FUSIONKIT_TELEMETRY` | Per-run telemetry override. |
| `DO_NOT_TRACK` | Force-disable telemetry. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | External OTLP endpoint; `--observe` supplies the local one when unset. |
| `PORTLESS`, `PORTLESS_STATE_DIR`, `PORTLESS_TLD` | Portless behavior. |

External RouteKit gateway authentication is referenced by the `router.authEnv`
name in Fusion config. Provider key variables are read by RouteKit, not
FusionKit.
