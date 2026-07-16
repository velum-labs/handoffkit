# `@routekit/cli`

`packages/routekit-cli` publishes the independent `@routekit/cli` npm package
and its `routekit` executable. It configures and serves model routes directly;
it does not depend on `@fusionkit/cli`, run fusion ensembles, start the Python
sidecar, or download local models.

## Install

```sh
npm install -g @routekit/cli
routekit config init
routekit serve
routekit codex
```

Configuration is loaded from `.routekit/router.yaml`, then
`~/.config/routekit/router.yaml`. Set `ROUTEKIT_CONFIG` to use an explicit
file and `ROUTEKIT_HOME` to relocate runtime state.

## Command ownership

| Command | RouteKit responsibility |
| --- | --- |
| `serve` | Run the configured OpenAI-compatible model gateway. |
| `codex`, `claude`, `cursor`, `opencode` | Launch one coding tool against an embedded gateway or `--gateway-url`; the optional model argument is an endpoint ID. |
| `endpoints list`, `add`, `remove`, `health` | Manage and probe configured endpoint IDs without printing credentials. |
| `models list` | List the endpoint IDs advertised as models. |
| `accounts add`, `remove`, `list`, `status`, `serve`, `stop` | Manage RouteKit-owned subscription accounts and the local account proxy. |
| `accounts cliproxy install`, `login`, `serve`, `status` | Manage RouteKit's pinned CLIProxyAPI integration. |
| `config path`, `show`, `init`, `edit`, `migrate` | Locate, validate, create, edit, or explicitly import RouteKit router state. |
| `install codex`, `uninstall codex` | Add or remove RouteKit-owned Codex provider/profile blocks. |
| `doctor` | Check router configuration, referenced credential variables, and installed coding-agent binaries. |
| `stop` | Stop only RouteKit-owned services and portless routes. |
| `telemetry status`, `on`, `off` | Control RouteKit's anonymous, opt-in product telemetry. |
| `completion <bash\|zsh\|fish>` | Print shell completion setup. |
| `version`, `--version` | Print the `@routekit/cli` version. |

Global options are `--config`, `--json`, `--no-input`, `--yes`, and `--quiet`.
Provider models, base URLs, endpoint pools, account relays, and credential
environment-variable references are RouteKit-owned. Fusion policy, panels,
judging, synthesis, and Fusion sessions are intentionally outside this package.
