# RouteKit user guide

> The canonical public guide is
> <https://fusionkit.velum-labs.com/docs/getting-started/routekit>. This
> Markdown file is an in-repository mirror for GitHub readers and maintainers.
>
> Research basis:
> [zero-context RouteKit user guide](research/matter/routekit-user-guide-2026-07-23.md).

This guide is for someone who has never used RouteKit before. It explains what
RouteKit does, why you might want it, and how to use it, step by step, with
copy-paste examples. No prior knowledge of this repository is assumed.

## What is RouteKit?

RouteKit is a command-line tool that gives your supported model providers and
subscription accounts **one local address**.

Without RouteKit, every tool you use has its own idea of where models live.
Your OpenAI key goes in one place, your Anthropic key in another, your Claude
and ChatGPT subscriptions only work inside their own apps, and nothing shares
anything.

With RouteKit, you set up each model source once. RouteKit then runs a small
background service on your machine that:

- lists the models those sources make available in **one catalog**;
- serves them through **one OpenAI-compatible endpoint** on your machine;
- lets coding tools like Codex CLI, Claude Code, and Cursor use compatible
  chat or tool-capable models from the catalog, not just models from the
  tool's own vendor;
- can hold **several subscription accounts at once** (for example two Claude
  accounts) and automatically switch between them when one runs out of quota.

RouteKit stores API keys outside its config file and keeps enrolled login
credentials in private local files. Requests still leave your machine and go
to the provider that serves the selected model. OpenRouter is an aggregator,
so requests sent through it also pass through OpenRouter. RouteKit itself is
not a hosted relay in the middle.

## What can I do with it?

The three main things people use RouteKit for:

1. **Run a coding tool on a different vendor's model.** For example, run the
   Codex CLI against Claude, or run Claude Code against a model from
   OpenRouter.

2. **Pool subscription accounts for local use.** Enroll two or more Claude
   Code or ChatGPT subscription accounts that you are allowed to use. When the
   first account hits its rate limit, RouteKit can switch to another eligible
   account instead of making you wait.

3. **Use one endpoint in your own code.** Point many libraries that only need
   RouteKit's listed OpenAI-compatible endpoint subset at the local gateway,
   then call models by name without juggling different SDKs and keys per
   provider.

## Before you start

You need:

- **Node.js 22.19 or newer.** Check with `node --version`.
- At least one way to reach a model. Either:
  - an **API key** from OpenAI (`OPENAI_API_KEY`), Anthropic
    (`ANTHROPIC_API_KEY`), or OpenRouter (`OPENROUTER_API_KEY`); or
  - a **subscription** you can log into: Claude Pro/Max (used by Claude Code)
    or ChatGPT Plus/Pro (used by Codex).
- The matching official command if you want RouteKit to launch a tool or
  enroll its subscription: `codex`, `claude`, or `cursor-agent`.

Model access is billed by the provider under your existing key or
subscription. The open-source RouteKit package does not add a separate hosted
service fee. Before you rely on a route, read how it authenticates, where
requests go, and how the provider bills it (see
[Checking a model before you use it](#checking-a-model-before-you-use-it)).

RouteKit exposes OpenAI, Anthropic, OpenRouter, Claude Code subscriptions, and
Codex subscriptions in its first-launch interface. It exposes launchers for
Codex, Claude Code, and Cursor. Other connectors may exist in the repository,
but they are not part of that interface.

> **Qualification notice:** Public support remains conditional until RouteKit's
> L06 qualification closes. Check the current pass, fail, and pending evidence
> in the
> [route and billing disclosures](https://fusionkit.velum-labs.com/docs/reference/routes-and-billing)
> before relying on a route.

## Install

```sh
npm install -g @velum-labs/routekit
```

This installs one command: `routekit`. Verify it:

```sh
routekit --version
```

## Ten-minute setup

RouteKit has one global config file:
`~/.config/routekit/router.yaml`. Choose the setup path that matches the
credential you already have.

### Path A: Start with an OpenAI API key

This is the shortest path because `routekit config init` creates an OpenAI
starter config:

```sh
export OPENAI_API_KEY=sk-...
routekit config init
```

The config contains the provider name, not the secret. RouteKit reads the key
from your environment. If the key is missing, `config init` still creates the
file but leaves the daemon stopped and tells you what to set.
The starter also sets `defaultModel: openai/gpt-5.5`. If that model is not in
your account's live catalog, import a complete config without `defaultModel`
to discover the catalog, then set an explicit chat-capable model before making
requests. The catalog is not filtered to chat-only models.

### Path B: Start with Anthropic or OpenRouter

Create a complete starter file for the provider you want, then import it. This
example uses Anthropic:

```sh
export ANTHROPIC_API_KEY=...

cat > routekit.yaml <<'YAML'
providers:
  anthropic: {}
YAML

routekit config import --from ./routekit.yaml
```

For OpenRouter, use `openrouter: {}` and set `OPENROUTER_API_KEY`. Import
validates the file, replaces the global config, and starts RouteKit. You may
delete the temporary `routekit.yaml` afterward.

### Path C: Start with only a Claude or ChatGPT subscription

Start the daemon with an empty provider list, then enroll the subscription.
The login transaction adds the matching provider to the config:

```sh
cat > routekit.yaml <<'YAML'
providers: {}
YAML

routekit config import --from ./routekit.yaml
```

Then choose one login.

For a Claude subscription:

```sh
npm install -g @anthropic-ai/claude-code
routekit accounts login claude-code --name personal
```

For a ChatGPT subscription used by Codex:

```sh
npm install -g @openai/codex
routekit accounts login codex --name personal
```

RouteKit runs the official CLI login in a private temporary profile, imports
the resulting credential, and deletes the temporary profile. It does **not**
replace your normal Claude Code or Codex login. For Codex on a headless
machine, `--no-browser` uses `codex login --device-auth`. Claude Code still
uses its official `claude auth login --claudeai` flow, which may present a URL
that you can open elsewhere.

### Start RouteKit

```sh
routekit start
```

This command is safe to repeat. The earlier import or login may already have
started a detached background service; `start` simply confirms that it is
healthy.

If you want the operating system to restart RouteKit after a crash, install its
systemd user service on Linux or launchd agent on macOS:

```sh
routekit daemon service install
```

The installer safely hands over from a detached daemon. If no supported OS
supervisor is available, it warns you and keeps using detached mode. On Linux,
successful user-lingering setup can keep the service across logout and reboot.
On macOS, the launchd agent starts in your user login session.

### See your models

```sh
routekit models list
```

You should see entries like:

```text
openai/gpt-5.5
anthropic/claude-sonnet-4-5
claude-code/claude-sonnet-4-6
codex/gpt-5.5
openrouter/moonshotai/kimi-k2-thinking
```

Your list will differ as providers add models and change account access. Copy
the exact ID of a chat-capable text model for the chat and coding-tool
examples below. `routekit models info <provider/model>` shows the metadata
RouteKit discovered; the raw catalog can also contain non-chat models.

Every model ID is written as `provider/model`. The part before the slash says
where the request will go and how it is billed. `anthropic/...` uses your
Anthropic API key; `claude-code/...` uses your enrolled Claude subscription
accounts. That distinction matters for cost, so RouteKit keeps it visible.

If something is not working, run the built-in checker:

```sh
routekit doctor
```

`doctor` checks every supported coding-tool binary. If you only need the
gateway or one tool, missing results for other unused tools are expected and
may make `doctor` exit with a non-zero status.

### Make your first request

Copy one exact ID from `routekit models list` into `MODEL`, then run:

```sh
MODEL="openai/gpt-5.5" # replace with a chat-capable ID from your catalog
TOKEN=$(routekit daemon auth show)
URL=$(routekit status --json | node -p \
  'JSON.parse(require("fs").readFileSync(0, "utf8")).daemon.dataUrl')

curl "$URL/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"$MODEL\",
    \"messages\": [{\"role\": \"user\", \"content\": \"Reply with: RouteKit works\"}]
  }"
```

The JSON response should contain an assistant message. If it does, your
config, credential, model catalog, gateway, and selected provider all work
together.

Before using a route with real data, read its
[credential, billing, egress, failover, and limitation disclosure](routekit-routes-and-billing.md).

## Using RouteKit with coding tools

RouteKit can launch Codex CLI, Claude Code, or Cursor against a model in your
catalog. Install the official tool you plan to use first:

```sh
# Install Codex CLI:
npm install -g @openai/codex

# Install Claude Code:
npm install -g @anthropic-ai/claude-code

# Install cursor-agent:
curl https://cursor.com/install -fsS | bash
```

Cursor desktop is a separate application. Install it from
<https://cursor.com>, open it, and sign in before using the `--ide` bridge.

You only need the tool you actually use. Then choose an exact, compatible
chat/tool model ID from `routekit models list`:

```sh
# Codex CLI, but running on Claude:
routekit codex anthropic/claude-sonnet-4-5

# Claude Code, but running on a subscription-pooled Claude model:
routekit claude claude-code/claude-sonnet-4-6

# Codex on its own subscription models (pooled by RouteKit):
routekit codex codex/gpt-5.5

# Cursor's command-line agent:
routekit cursor openai/gpt-5.5

# Connect the Cursorkit bridge to an installed, signed-in Cursor desktop:
routekit cursor --ide openai/gpt-5.5
```

For Codex, Claude Code, and `cursor-agent`, RouteKit starts the real tool and
points it at the local gateway. `cursor --ide` instead starts the Cursorkit
bridge and waits for an installed, open, signed-in Cursor desktop; the current
IDE path also requires `cursor-agent` on `PATH`. If you omit the model, the
launcher gets your configured default model. Use `--` before flags that belong
to the launched tool rather than RouteKit:

```sh
routekit codex anthropic/claude-sonnet-4-5 -- --full-auto
```

Inside Claude Code and Codex, the model picker still shows familiar bare names
(such as `claude-sonnet-4-6` or `gpt-5.5`) for their own subscription models.
Those are display aliases; the requests still go through RouteKit's managed
account pool.

## Using RouteKit from your own code

The gateway implements the OpenAI-compatible endpoints listed below, so many
OpenAI-compatible libraries can use it. A client that requires an unlisted
OpenAI API or provider feature may not work. You need the gateway URL and its
access token.

```sh
routekit status              # shows the gateway URL
routekit daemon auth show    # shows the access token (keep it private)
```

The token protects the gateway so that only software you gave the token to
can spend your money. It is stored at `~/.routekit/secrets/data-token` and
never appears in logs or status output.

**curl:**

```sh
TOKEN=$(routekit daemon auth show)
URL=$(routekit status --json | node -p \
  'JSON.parse(require("fs").readFileSync(0, "utf8")).daemon.dataUrl')

curl -i "$URL/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic/claude-sonnet-4-5",
    "messages": [{ "role": "user", "content": "Say hello in one word." }]
  }'
```

**Python (openai library):**

```sh
python -m pip install openai
```

```python
from openai import OpenAI

client = OpenAI(base_url="<URL>/v1", api_key="<TOKEN>")

reply = client.chat.completions.create(
    model="openai/gpt-5.5",
    messages=[{"role": "user", "content": "Say hello in one word."}],
)
print(reply.choices[0].message.content)
```

**Node.js (openai package):**

```sh
npm install openai
```

```js
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "<URL>/v1", apiKey: "<TOKEN>" });

const reply = await client.chat.completions.create({
  model: "openai/gpt-5.5",
  messages: [{ role: "user", content: "Say hello in one word." }],
});
console.log(reply.choices[0].message.content);
```

Useful endpoints on the gateway:

| Endpoint | What it does |
| --- | --- |
| `GET /v1/models` | List all available models. |
| `POST /v1/chat/completions` | OpenAI-style chat (streaming supported). |
| `POST /v1/messages` | Anthropic-style messages, for Anthropic-native clients. |
| `POST /v1/messages/count_tokens` | Estimate tokens locally, or delegate to the native Claude subscription relay when that route is selected. |
| `POST /v1/responses` | OpenAI Responses API, for Responses-native clients. |
| `POST /v1/embeddings` | Embeddings. |
| `GET /health` | Check listener health and whether the gateway is draining; it does not verify model availability. |

You always use the same URL and token regardless of which provider actually
serves the model. Use the full `provider/model` ID in your own code. There are
two endpoint-specific native-client exceptions: `/v1/messages` can resolve
bare Claude Code aliases, and `/v1/responses` can resolve bare Codex aliases.
Configuration, Chat Completions, and embeddings remain namespaced. An unknown
model is rejected rather than silently sent to a default. The gateway also
accepts the same token in an `x-api-key` header when a client cannot set
`Authorization`.

### Connecting a tool to an existing gateway

You can point a RouteKit launcher at a gateway that is already running
somewhere else:

```sh
export ROUTEKIT_GATEWAY_TOKEN=<token-from-the-gateway-operator>

routekit codex \
  --gateway-url https://routekit.example.com \
  --auth-token-env ROUTEKIT_GATEWAY_TOKEN \
  anthropic/claude-sonnet-4-5
```

Use HTTPS for any gateway that is not on your own machine. RouteKit requires
authentication when it binds beyond loopback, but it does not add user
accounts, roles, or per-user limits. Put any intentionally remote deployment
behind appropriate TLS, firewall, and access controls. Do not expose personal
subscription connectors through a shared gateway.

## Pooling subscription accounts

If you personally have more than one Claude or ChatGPT subscription that you
are allowed to use, enroll each one with a clear local label:

```sh
routekit accounts login claude-code --name personal
routekit accounts login claude-code --name work
routekit accounts status
```

From then on, requests to `claude-code/...` models pick a healthy enrolled
account automatically. Each account's quota, cooldowns, and reset times are
tracked separately. Quota exhaustion can move the request through the
remaining eligible accounts. A transient throttle gets one same-account retry
and at most one alternate account so a provider-wide problem is not amplified.
Authentication, invalid-request, and unknown failures return immediately.
RouteKit never silently reroutes a subscription request to a paid API key.

Watch your quota in real time:

```sh
routekit usage              # rate-limit windows, credits, reset times
routekit usage --watch 30   # refresh every 30 seconds
```

You can tune how accounts are chosen in the config file:

```yaml
providers:
  claude-code:
    strategy: capacity_weighted   # or: sticky, round_robin
    switchThreshold: 0.9          # switch when 90% of the window is used
```

- `sticky` keeps a model on one account while that account remains eligible,
  including below the switch threshold.
- `round_robin` rotates among eligible accounts.
- `capacity_weighted` considers quota headroom and current in-flight load.

Other account commands:

```sh
routekit accounts list
routekit accounts remove claude-code work
routekit accounts add claude-code --name current-login
```

`accounts add` imports the login your official CLI is already using instead of
running a fresh isolated login.

The first-launch subscription connectors reuse provider OAuth credentials over
provider-native endpoints and are intended for personal, local use. Do not
turn this into a shared team gateway unless the provider explicitly permits
that use. RouteKit does not provide team identities, roles, per-person keys,
or per-person spending limits.

## Checking a model before you use it

Ask RouteKit to explain any model:

```sh
routekit models info claude-code/claude-sonnet-4-6
```

This shows which provider serves it, the native model name, whether it is
billed as a metered API or through a subscription, whether it is your default
model, and what capabilities (such as reasoning-effort levels) were
discovered. Nothing in the output contains credentials.

Accepted chat, Messages, Responses, and embeddings model calls include an
`x-routekit-model-call-id` response header. Use that value to inspect what the
request actually did: the route it took, retries, account failovers, token
usage, and estimated cost:

```sh
routekit calls inspect <call-id>
```

Attribution records are bounded and belong to the current daemon process, so
inspect a call before restarting or upgrading RouteKit.

## Everyday commands

| Command | What it does |
| --- | --- |
| `routekit start` | Start the background service (idempotent). |
| `routekit status` | Show the daemon, gateway URL, providers, and version. |
| `routekit stop` | Gracefully stop; running requests get time to finish. |
| `routekit models list` | List every available model. |
| `routekit models info <id>` | Explain one model's route and billing. |
| `routekit usage` | Show subscription quota and reset windows. |
| `routekit calls inspect <id>` | Show one request's routing and cost. |
| `routekit doctor` | Diagnose config, credentials, and tool binaries. |
| `routekit config show` | Print the effective config. |
| `routekit config edit` | Open the config in your editor. |
| `routekit accounts status` | Show enrolled accounts and their health. |
| `routekit providers status` | Show providers and live model discovery. |
| `routekit telemetry status` | Show the stored opt-in telemetry preference. |

Most inspection and management commands accept `--json` for machine-readable
output. Interactive OAuth, editor, tool-launch, log-follow, and live-watch
commands deliberately do not.

## The config file, briefly

RouteKit has exactly one config file: `~/.config/routekit/router.yaml`. A
complete, realistic example:

```yaml
providers:
  openai: {}
  anthropic: {}
  claude-code:
    strategy: capacity_weighted
    switchThreshold: 0.9
defaultModel: openai/gpt-5.5
```

Rules worth knowing:

- **Providers are switches, not URLs.** `openai: {}` means "enable OpenAI".
  RouteKit already knows the URL and which environment variable holds the key.
- **No secrets in the file.** API keys stay in environment variables;
  subscription credentials stay in RouteKit's private store with restrictive
  file permissions.
- **`defaultModel`** is what you get when a tool or request does not name a
  model explicitly.
- Edits through `routekit config edit` or `routekit config import --from
  <file>` are validated and applied atomically; the daemon finishes in-flight
  requests on the old configuration while new traffic uses the new one.

You can add or remove a provider without editing YAML:

```sh
routekit providers add anthropic
routekit providers remove anthropic
routekit providers status
```

`providers add` works only when the running daemon already has that provider's
credential. Exporting a new key in a later shell does not change an existing
daemon. `providers remove` also refuses to remove the only configured
provider; import a complete `providers: {}` config when you intentionally want
an empty router.

For a systemd service, provider keys live in
`~/.routekit/env/daemon.env`; update that mode-`0600` file and restart. For a
launchd service, export **every** API key used by the current config and rerun
`routekit daemon service install` so RouteKit can validate the full
environment and rewrite the private plist. A detached daemon inherits keys
when it starts, so export them before restarting it.

To add a new API provider to an already supervised installation, the portable
path is to export all old and new configured keys, stop and uninstall the
service, import one complete config containing the new provider, and reinstall
the service:

```sh
routekit stop
routekit daemon service uninstall
routekit config import --from ./complete-router.yaml
routekit daemon service install
```

`daemon reload` reloads config and accounts, not process environment. See the
[package daemon runbook](../packages/routekit-cli/README.md#singleton-daemon)
for the platform-specific details.

## How it works (one paragraph)

After a valid config exists, the first daemon-backed `routekit` command starts
one background daemon for your user. The daemon owns the config, provider
connections, subscription account pools, and one authenticated,
OpenAI-compatible gateway on your machine. Every CLI command is a thin client
of that daemon, and every tool or program you connect uses the same gateway.
Stopping, restarting, and upgrading drain gracefully: in-flight model
responses (including long streams) get up to 30 seconds to finish before the
process goes away. After you install a new RouteKit version, run
`routekit daemon upgrade` or keep using it; the next product command notices
the version change and gracefully restarts the older daemon.

## Updating or removing RouteKit

Upgrade the npm package, then let RouteKit replace its running daemon:

```sh
npm install -g @velum-labs/routekit@latest
routekit daemon upgrade
```

To remove RouteKit completely, stop it and remove any installed user service
before uninstalling the npm package:

```sh
routekit stop
routekit daemon service uninstall
npm uninstall -g @velum-labs/routekit
```

RouteKit does not delete your config or enrolled credentials automatically.
Review `~/.config/routekit/` and `~/.routekit/` yourself before removing those
directories.

## Troubleshooting

**"cannot start RouteKit: set OPENAI_API_KEY ..."** — a configured provider
has no credential. Export the named variable and run `routekit start`. If you
do not want that provider, import a complete replacement config that omits it.

**A model is missing from `models list`.** Discovery happens per provider at
startup. Check `routekit providers status` for a provider-specific error. If
you changed config or accounts, run `routekit daemon reload`; if you changed
an environment variable, update the detached/systemd/launchd environment as
described above, then run `routekit daemon restart`.

**"unknown model" errors from your own code.** Use the full namespaced ID
exactly as `models list` prints it, including the `provider/` prefix.

**Everything seems stuck.** `routekit status` first, then `routekit doctor`,
then `routekit daemon logs -f` to watch the daemon log live.

**Where does my data go?** Requests leave your machine for the route shown by
`routekit models info`. Direct providers receive them directly. OpenRouter
receives and forwards requests for its upstream providers. The telemetry
commands store an opt-in consent preference, which is off by default. The
current RouteKit CLI does not initialize an event transport.

## What RouteKit is not

RouteKit routes single requests to single models. It does not combine multiple
models' answers into one better answer — that is **FusionKit**
(`@fusionkit/cli`), a separate product in this repository that builds on
RouteKit. You can use RouteKit entirely on its own, and this guide does not
require anything from FusionKit. RouteKit also does not download local models
and is not a hosted, multi-user team control plane.

## Where to go next

- [Per-route billing and provider disclosures](https://fusionkit.velum-labs.com/docs/reference/routes-and-billing)
  — exactly how each route authenticates, bills, and fails over.
- [Subscription pooling](https://fusionkit.velum-labs.com/docs/guides/subscription-pooling)
  — the account pool design in more depth.
- [Configuration](https://fusionkit.velum-labs.com/docs/reference/configuration)
  — the standalone RouteKit config reference.
- [`@velum-labs/routekit` package README](../packages/routekit-cli/README.md)
  — the complete command table and daemon runbook.
