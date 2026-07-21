# Configuration

FusionKit v4 separates fusion policy from model routing:

- `.fusionkit/fusion.json` defines ensembles and FusionKit behavior.
- `.routekit/router.yaml` explicitly enables providers and selects an optional
  default from RouteKit's live model catalog.

FusionKit reads only namespaced RouteKit model IDs (`provider/model`). RouteKit
does not read ensembles. Provider API keys and subscription credentials stay
outside both files.

## Scaffold both files

```sh
fusionkit init
```

If `.routekit/router.yaml` does not exist, `init` creates a provider-based
placeholder. Edit that file directly or install the independent
`@routekit/cli` and use `routekit providers`.

## FusionKit v4

```json
{
  "version": "fusionkit.fusion.v4",
  "router": { "config": ".routekit/router.yaml" },
  "tool": "codex",
  "defaultEnsemble": "default",
  "ensembles": {
    "default": {
      "members": ["openai/gpt-5.5", "anthropic/claude-sonnet-4-5"],
      "judge": "anthropic/claude-sonnet-4-5",
      "synthesizer": "anthropic/claude-sonnet-4-5",
      "k": 1
    }
  },
  "observe": false,
  "onRateLimit": "fusion",
  "budgetUsd": 5,
  "panelTrust": "full",
  "reasoning": true,
  "subagents": true,
  "portless": true
}
```

`router` sets exactly one connection:

- `{ "config": ".routekit/router.yaml" }` starts an embedded RouteKit router
  owned by the Fusion process.
- `{ "url": "http://127.0.0.1:8787", "authEnv": "ROUTEKIT_TOKEN" }`
  connects to an external router. FusionKit validates `/v1/models` but never
  stops that external process. The recommended target is the stable data URL
  of the singleton RouteKit daemon (`routekit daemon service install`): it survives
  Fusion sessions, restarts on crash/reboot when supervised, transactionally
  reloads routing/account generations, and upgrades via `routekit daemon
  upgrade`.

Each ensemble requires non-empty `members` and a `judge`, all expressed as
namespaced IDs advertised by RouteKit's live `/v1/models` catalog.
`synthesizer` defaults to the judge. Per-ensemble `k` overrides the top-level
value.

Top-level policy fields are `tool`, `defaultEnsemble`, `observe`, `portless`,
`port`, `onRateLimit`, `budgetUsd`, `panelTrust`, `k`, `reasoning`, and
`subagents`. Supported tools are `codex`, `claude`, `cursor`, `opencode`, and
`serve`.

Provider policy, credentials, registry URLs, pricing, and subscription-account
enrollment are invalid in this file.

## RouteKit router

The standalone `routekit` CLI daemon uses exactly one canonical config:
`~/.config/routekit/router.yaml`. It does not vary routing policy by the
caller's working directory; that would make one gateway ambiguous when two
projects run concurrently. Import an existing project overlay explicitly:

```sh
routekit config import --from .routekit/router.yaml
```

Project `.routekit/router.yaml` discovery remains part of the embeddable
`@routekit/config` / `@routekit/router` SDK contract and therefore remains
valid for FusionKit's `{ "config": ... }` embedded mode. `--config` and
`ROUTEKIT_CONFIG` are recovery/foreground SDK paths, not daemon-backed command
scope selectors.

Enable each provider explicitly. RouteKit obtains API URLs and credential
environment-variable names from its registry, performs live discovery at
startup, and publishes only namespaced model IDs:

```yaml
providers:
  openai: {}
  anthropic: {}
defaultModel: openai/gpt-5.5
```

The supported provider IDs are `openai`, `anthropic`, `google`, `openrouter`,
`cliproxy`, `codex`, and `claude-code`. API providers read registry-defined
environment variables such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`GEMINI_API_KEY`, and `OPENROUTER_API_KEY`. Optional registry-defined base URL
variables support compatible deployments without placing URLs in router YAML.

Subscription providers are configured in the same map. Their policy controls
selection across every enrolled account:

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

Log in one or more named accounts through RouteKit. Each login uses an isolated
temporary official-CLI profile, so it does not replace the user's normal Claude
Code or Codex login. The first enrollment adds the provider to the effective
config; no model or route is created manually:

```sh
routekit accounts login claude-code --name personal
routekit accounts login claude-code --name work
routekit accounts login codex --name primary
routekit accounts status
routekit models list
routekit claude claude-code/claude-sonnet-4-5
```

`routekit accounts add <kind> --name <label>` remains available for explicitly
importing the current official CLI login.

Startup discovers models from every healthy account and publishes their union
under one provider namespace. Requests are eligible only for accounts that
advertise the requested model. Quotas, refresh, cooldowns, and reset windows are
tracked per account; `sticky`, `round_robin`, and `capacity_weighted` select
among eligible accounts. A pooled exhaustion error is returned only when all
eligible accounts are unavailable.

RouteKit rejects inline API keys, authorization headers, and tokens. Its SDK
loads configuration with this precedence:

```text
explicit config path > ROUTEKIT_CONFIG > project .routekit/router.yaml > global config
```

Project and global files are layered when no explicit path is selected.
Omitting a model selects `defaultModel` (or the first live model). Supplying an
unknown or unnamespaced model is an error and never falls through to that
default. If any configured provider cannot authenticate or discover models,
startup fails with a provider-specific diagnostic.

## Precedence and editing

Run settings resolve as:

```text
CLI flag > .fusionkit/fusion.json > built-in default
```

```sh
fusionkit config show
fusionkit config get budgetUsd
fusionkit config set budgetUsd 5
fusionkit config set ensembles.default.judge anthropic/claude-sonnet-4-5
fusionkit config unset budgetUsd
fusionkit config edit

fusionkit ensemble add review \
  --member openai/gpt-5.5 \
  --member anthropic/claude-sonnet-4-5 \
  --judge anthropic/claude-sonnet-4-5
fusionkit ensemble edit review \
  --member anthropic/claude-sonnet-4-5 \
  --judge anthropic/claude-sonnet-4-5
fusionkit ensemble rename review thorough
fusionkit ensemble remove thorough
```

Every mutation is validated and written atomically.

## Prompt overrides

Prompt text remains in files, not inline JSON:

```text
.fusionkit/prompts/judge.md
.fusionkit/prompts/synthesizer.md
.fusionkit/prompts/<ensemble>/judge.md
.fusionkit/prompts/<ensemble>/synthesizer.md
```

Use `fusionkit prompts list|edit|reset`; per-ensemble files override the flat
defaults.

## Migrating v3

FusionKit does not silently dual-read v3. Loading a v1-v3 file returns migration
guidance:

1. Run `routekit config migrate` for a legacy router file. Known providers and
   account policies become provider entries; custom aliases, pools, custom
   URLs, and custom credential variables are reported when they cannot be
   represented.
2. Replace every legacy endpoint alias in Fusion ensembles with the live
   `provider/model` ID reported by `routekit models list`.
3. Set the config version to `fusionkit.fusion.v4` and add `router.config` or
   `router.url`.

Runtime loading rejects legacy `endpoints`, `accounts`, and
`defaultEndpointId` fields. The generated Python sidecar receives only
namespaced model IDs and the RouteKit gateway URL. It receives no provider
credential or provider configuration.
