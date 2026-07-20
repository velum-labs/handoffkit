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
| `codex`, `claude`, `cursor`, `opencode` | Launch one coding tool against an embedded gateway or `--gateway-url`; the optional argument is a namespaced `provider/model` ID. |
| `providers add`, `remove`, `status` | Manage explicit providers and run live discovery without printing credentials. |
| `models list` | Discover and list the live namespaced model catalog. |
| `accounts login` | Run an isolated official Claude Code or Codex login, enroll the credential into the native pool, and enable that provider. |
| `accounts add`, `remove`, `list`, `status` | Import the current official CLI login or manage enrolled native subscription accounts. |
| `usage` | Show subscription rate limits, credits, and reset windows from the running gateway or enrolled local accounts. |
| `accounts serve`, `stop` | Advanced mode: expose subscription pools as a separate external proxy. Normal provider routing does not require it. |
| `accounts cliproxy install`, `login`, `serve`, `status` | Manage RouteKit's pinned CLIProxyAPI integration. |
| `config path`, `show`, `init`, `edit`, `migrate` | Locate, validate, create, edit, or explicitly import RouteKit router state. |
| `install codex`, `uninstall codex` | Add or remove RouteKit-owned Codex provider/profile blocks. |
| `doctor` | Check router configuration, referenced credential variables, and installed coding-agent binaries. |
| `stop` | Stop only RouteKit-owned services and portless routes. |
| `telemetry status`, `on`, `off` | Control RouteKit's anonymous, opt-in product telemetry. |
| `completion <bash\|zsh\|fish>` | Print shell completion setup. |
| `version`, `--version` | Print the `@routekit/cli` version. |

Global options are `--config`, `--json`, `--no-input`, `--yes`, and `--quiet`.
`routekit usage` does not require `accounts serve`: it reads the normal gateway
when available and otherwise inspects enrolled accounts directly.
Provider activation, live model catalogs, account relays, and registry-defined
credential environment variables are RouteKit-owned. Fusion policy, panels,
judging, synthesis, and Fusion sessions are intentionally outside this package.

Subscription kinds are `claude-code` and `codex`; the Claude Code launcher
command remains `routekit claude [provider/model]`. Pool policy uses the same
provider map as API-key sources:

```yaml
providers:
  claude-code:
    strategy: capacity_weighted
    switchThreshold: 0.9
  codex:
    strategy: capacity_weighted
    switchThreshold: 0.9
defaultModel: codex/gpt-5.5
```

The default enrollment path is
`routekit accounts login <kind> --name <label>`. RouteKit gives the official provider CLI a private temporary profile,
atomically imports the resulting credential, and removes the temporary profile
without changing the user's normal login. `accounts add` is the explicit
current-login import path.

API providers infer their key and optional base URL from registry-defined
environment variables. Subscription providers discover the union of models
offered by healthy enrolled accounts and keep per-account quota, refresh,
cooldown, and model eligibility state. An explicitly requested unknown or
unnamespaced model is rejected rather than routed to the default.
