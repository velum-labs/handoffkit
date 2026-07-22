# `@routekit/cli`

`packages/routekit-cli` publishes the independent `@routekit/cli` npm package
and its `routekit` executable. It configures and serves model routes directly;
it does not depend on `@fusionkit/cli`, run fusion ensembles, start the Python
sidecar, or download local models.

## Install

```sh
npm install -g @routekit/cli
routekit config init
routekit start
routekit codex
```

The singleton daemon loads `~/.config/routekit/router.yaml`; replace that
canonical document from a project file explicitly with
`routekit config import --from .routekit/router.yaml`. Import validates and
atomically replaces the complete document; it does not merge configuration.
Sparse SDK overlays must be expanded into a complete router document before
import. `--config` / `ROUTEKIT_CONFIG` are reserved for foreground gateway,
doctor, and migration recovery paths. `ROUTEKIT_HOME` relocates runtime state.

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
| `start`, `status`, `stop` | Start, inspect, and gracefully stop RouteKit through its singleton daemon. |
| `codex`, `claude`, `cursor` | Ask the daemon to prepare a launch, then run the supported coding tool locally against the singleton gateway. |
| `codex install`, `codex uninstall` | Add or remove RouteKit-owned Codex provider/profile blocks. |
| `claude install`, `claude uninstall` | Add or remove RouteKit-owned Claude Code gateway settings while preserving user configuration. |
| `providers add`, `remove`, `status` | Manage explicit providers and run live discovery without printing credentials. |
| `models list` | Discover and list the live namespaced model catalog. |
| `accounts login` | Enroll a supported subscription kind (`claude-code` or `codex`), import the credential, and enable the matching provider. `--no-browser` prefers a device-code / copyable-URL flow for headless hosts. |
| `accounts add`, `remove`, `list`, `status` | Import the current official CLI login or manage enrolled subscription accounts. |
| `usage` | Show subscription rate limits, credits, and reset windows from the running gateway or enrolled local accounts. |
| `config path`, `show`, `init`, `edit`, `import`, `migrate` | Manage the daemon's canonical global router config with revision-checked writes. |
| `doctor` | Check router configuration, referenced credential variables, and installed coding-agent binaries. |
| `telemetry status`, `on`, `off` | Control RouteKit's anonymous, opt-in product telemetry. |
| `completion <bash\|zsh\|fish>` | Print shell completion setup. |
| `version`, `--version` | Print the `@routekit/cli` version. |

Global options are `--json`, `--no-input`, `--yes`, and `--quiet`. `--config`
is retained only for foreground/recovery migration; daemon-backed commands use
the canonical `~/.config/routekit/router.yaml`. `routekit usage` asks the
daemon-owned account pools directly.
Provider activation, live model catalogs, account relays, and registry-defined
credential environment variables are RouteKit-owned. Fusion policy, panels,
judging, synthesis, and Fusion sessions are intentionally outside this package.

The first-launch subscription kinds are `claude-code` and `codex`; the Claude
Code launcher command remains `routekit claude [provider/model]`.
Pool policy uses the same provider map as API-key sources:

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

The one enrollment path is `routekit accounts login <kind>`. The supported
`claude-code` and `codex` kinds run the official provider CLI in a private
temporary profile, atomically import the resulting credential, and remove the
temporary profile without changing the user's normal login (`accounts add` is
the explicit current-login import path). `--no-browser` prefers a device-code /
copyable-URL flow so a headless host only needs a browser on some other device.

API providers infer their key and optional base URL from registry-defined
environment variables. Subscription providers discover the union of models
offered by healthy enrolled accounts and keep per-account quota, refresh,
cooldown, and model eligibility state. An explicitly requested unknown or
unnamespaced model is rejected rather than routed to the default.

## First-launch support contract

RouteKit's public first-launch set is:

- API providers: OpenAI, Anthropic, and OpenRouter;
- subscriptions: Codex and Claude Code; and
- harnesses: Codex CLI, Claude Code, Cursor IDE, and `cursor-agent` through
  Cursor's custom OpenAI endpoint.

Read the
[per-route credential, billing, egress, failover, and limitation disclosures](https://fusionkit.velum-labs.com/docs/reference/routes-and-billing)
before enabling a route. OpenRouter is an aggregator; API-key and subscription
routes have different billing and quota boundaries.

Public support remains conditional on L06 qualification. The neutral registry
and internal packages may retain additional providers, connectors, and tool
integrations for compatibility and development. Those retained implementations
are not first-launch UX, are not qualified, and are not a support contract.

## Singleton daemon

Every product command is a thin client of one daemon per `ROUTEKIT_HOME`.
The daemon owns:

- a private, random-token-authenticated `control.v1` listener on loopback;
- one stable OpenAI-compatible gateway listener;
- the canonical config, provider discovery/cache, subscription account pools,
  usage, and telemetry state; and
- transactional router generations. Config/account changes build and validate
  a replacement router first, atomically switch new traffic, then drain the old
  generation so active LLM streams finish.

`accounts login` and `accounts add` use one `accounts.enrollActivate` control
mutation. OAuth capture is isolated from daemon-owned stores; the daemon keeps
a private rollback vault while it commits account files, provider config,
account/config revisions, and the router generation. An error restores prior
state, and startup rolls back any prepared transaction before loading config.
Committed retries are no-ops. Status and doctor report sanitized recovery and
account/provider consistency without returning transaction credentials.

Help, version, completion, terminal rendering, OAuth/editor interaction, and
the final coding-tool process remain local. Interactive results are committed
back through authenticated RPC, so the daemon remains the sole RouteKit state
writer. Project `.routekit/router.yaml` files are SDK/embedded-router inputs,
not standalone daemon scopes. To migrate one into the singleton, explicitly
replace its canonical document:

```sh
routekit config import --from .routekit/router.yaml
```

The first product command race-safely ensures the singleton exists. Where a
systemd user manager or launchd is available it installs/starts the persistent
unit; unsupported container/WSL environments use the documented detached
fallback. Users do not need to select foreground, detached, or supervised
operation. The public lifecycle is:

```sh
routekit start
routekit status
routekit stop
```

`start` is idempotent and uses the same daemon bootstrap as every product
command. It writes `routekit-daemon.service` / the launchd agent when an OS
supervisor is available (with lingering on Linux so it survives logout and
reboot), starts it, and verifies authenticated control health before printing
the data URL.
On systemd, provider credentials for the configured providers are captured
into a private `~/.routekit/env/daemon.env` (mode 0600) referenced by the
unit; edit that file to rotate provider keys, then restart the daemon so the
supervisor supplies the new process environment. The advanced `daemon reload`
command reloads
router/account state, not process environment. The gateway bearer is generated
into `~/.routekit/secrets/data-token` (0600) and never appears in status, logs,
or process arguments; `routekit daemon auth show` reveals it only when
explicitly requested for an external client such as FusionKit. Where no
init supervisor exists (containers, some WSL setups), `start` falls back to a
detached daemon.

### Advanced lifecycle operations

```sh
routekit daemon reload
routekit daemon restart
routekit daemon upgrade
routekit daemon logs -f
routekit daemon service install
routekit daemon service status
routekit daemon service uninstall
```

The hidden `daemon` command group remains available for repair, diagnostics,
and automation compatibility. `daemon service install` rewrites a moved
systemd/launchd unit. The only foreground entrypoint is the internal
`daemon run`, which supervisors and the detached spawner execute; it is not a
user workflow.

### Migrating existing lifecycle commands

- Replace `routekit daemon start` with `routekit start`, `routekit daemon
  status` with `routekit status`, and `routekit daemon stop` with `routekit
  stop`. The former commands remain compatible but are omitted from primary
  help.
- Existing `routekit daemon service install` users can use `routekit start`;
  RouteKit chooses and installs the available supervisor automatically. Keep
  the service command only for unit repair, inspection, or removal.
- `routekit gateway serve` has been removed. Use `routekit start`; external
  clients read the gateway URL from `routekit status` and the data token from
  `routekit daemon auth show`.
- On first daemon-backed startup, RouteKit retires legacy `gateway` records and
  systemd/launchd units before publishing the singleton daemon record.
- Import project configuration with `routekit config import --from
  .routekit/router.yaml`; the singleton never silently adopts a project
  overlay. `--config` / `ROUTEKIT_CONFIG` remain doctor/migration recovery
  flags only.

### Graceful shutdown and upgrades

Shutdown, restart, and upgrade all drain: `/health` flips to 503, new requests
are rejected, and in-flight requests (long-lived LLM streams) get up to the
drain grace (default 30s; `--drain-grace <seconds>` or `ROUTEKIT_DRAIN_GRACE`)
to finish before the listener is severed.

After installing a new `@routekit/cli`, the next product command negotiates
the package/protocol version and gracefully restarts an older daemon before
retrying. The explicit form is:

```sh
routekit daemon upgrade
```

replaces the combined daemon after draining model traffic. A fixed loopback
port has a brief bounded rebind gap; portless keeps the stable client URL.
`upgrade --force` also rolls the process without version skew. Supervised
services restart through their supervisor; re-run `daemon service install`
only if the global `routekit` binary location moved.
