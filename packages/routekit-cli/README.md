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

## Local checkout development

Contributors can install a separate global `routekit-dev` command that always
runs their local checkout instead of the published npm package:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev:link-routekit
routekit-dev --version
```

Run it from any project repo:

```bash
cd your-project
routekit-dev doctor
routekit-dev codex
```

The dev command rebuilds `packages/routekit-cli` before launch, preserves the
caller's working directory, and does not replace the normal `routekit` binary.
Set `ROUTEKIT_DEV_SKIP_BUILD=1` after a build for a faster local check.

## Command ownership

| Command | RouteKit responsibility |
| --- | --- |
| `serve` | Run the configured OpenAI-compatible model gateway. |
| `codex`, `claude`, `cursor`, `opencode` | Launch one coding tool against an embedded gateway or `--gateway-url`; the optional model argument is an endpoint ID. |
| `endpoints list`, `add`, `remove`, `health` | Manage and probe configured endpoint IDs without printing credentials. |
| `models list` | List the endpoint IDs advertised as models. |
| `accounts add`, `remove`, `list`, `status` | Manage RouteKit-owned `claude-code` and `codex` subscription accounts. Adding an account enables that kind in the effective router config. |
| `accounts serve`, `stop` | Advanced mode: expose the subscription pool as a separate external proxy. Normal account-backed endpoints do not require it. |
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

Subscription kinds are `claude-code` and `codex`; the Claude Code launcher
command remains `routekit claude [endpoint-id]`. Account-backed endpoints use
only `endpointId`, `model`, and `account`:

```yaml
endpoints:
  - endpointId: private-review
    model: claude-sonnet-4-5
    account: claude-code
accounts:
  claude-code:
    enabled: true
```

The endpoint ID is opaque and can be referenced unchanged from a Fusion v4
ensemble. URL-backed endpoints instead use `baseUrl`, `dialect`, and optional
`apiKeyEnv`; they do not set `account`. An explicitly requested unknown
endpoint ID is rejected rather than routed to the default.
