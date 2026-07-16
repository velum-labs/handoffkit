# Configuration

FusionKit v4 separates fusion policy from model routing:

- `.fusionkit/fusion.json` defines ensembles and FusionKit behavior.
- `.routekit/router.yaml` defines provider models, URLs, credential environment
  variables, accounts, and endpoint routing.

FusionKit reads only opaque RouteKit endpoint IDs. RouteKit does not read
ensembles. Both files are safe to commit when credentials are referenced by
environment-variable name.

## Scaffold both files

```sh
fusionkit init
```

If `.routekit/router.yaml` does not exist, `init` creates a safe placeholder
using `apiKeyEnv`. Edit that file directly or install the independent
`@routekit/cli` and use `routekit endpoints`.

## FusionKit v4

```json
{
  "version": "fusionkit.fusion.v4",
  "router": { "config": ".routekit/router.yaml" },
  "tool": "codex",
  "defaultEnsemble": "default",
  "ensembles": {
    "default": {
      "members": ["fast", "deep"],
      "judge": "deep",
      "synthesizer": "deep",
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
  stops that external process.

Each ensemble requires non-empty `members` and a `judge`, all expressed as
RouteKit endpoint IDs. `synthesizer` defaults to the judge. Per-ensemble `k`
overrides the top-level value.

Top-level policy fields are `tool`, `defaultEnsemble`, `observe`, `portless`,
`port`, `onRateLimit`, `budgetUsd`, `panelTrust`, `k`, `reasoning`, and
`subagents`. Supported tools are `codex`, `claude`, `cursor`, `opencode`, and
`serve`.

Provider names, provider model IDs, `baseUrl`, `apiKeyEnv`, pricing, and
subscription-account definitions are invalid in this file.

## RouteKit router

URL-backed endpoints keep provider connection details in RouteKit:

```yaml
endpoints:
  - endpointId: deep
    model: provider-model-id
    provider: openai-compatible
    baseUrl: https://provider.example/v1
    dialect: openai
    apiKeyEnv: PROVIDER_API_KEY
defaultEndpointId: deep
```

Subscription-backed endpoints use the canonical `claude-code` or `codex`
account kind and omit URL/provider/credential fields:

```yaml
endpoints:
  - endpointId: private-review
    model: claude-sonnet-4-5
    account: claude-code
  - endpointId: private-coder
    model: gpt-5.5-codex
    account: codex
accounts:
  claude-code:
    enabled: true
  codex:
    enabled: true
defaultEndpointId: private-review
```

The `endpointId` values are opaque; names such as `private-review` can be used
unchanged in Fusion ensembles. Enroll an existing official CLI login with
`routekit accounts add claude-code` or `routekit accounts add codex`. Adding an
account automatically sets that account kind to `enabled: true` in the
effective router config. Add the corresponding endpoint separately:

```sh
routekit endpoints add private-review \
  --model claude-sonnet-4-5 --account claude-code
routekit claude private-review
```

The tool command remains `routekit claude`; `claude-code` is the subscription
kind. `routekit accounts serve` is only for exposing the pool as an advanced
external proxy and is not required for normal account-backed endpoints.

RouteKit rejects inline API keys, authorization headers, and tokens. Its SDK
loads configuration with this precedence:

```text
explicit config path > ROUTEKIT_CONFIG > project .routekit/router.yaml > global config
```

Project and global files are layered when no explicit path is selected.
Omitting an endpoint ID selects `defaultEndpointId` (or the first configured
endpoint). Supplying an unknown ID is an error and never falls through to that
default.

## Precedence and editing

Run settings resolve as:

```text
CLI flag > .fusionkit/fusion.json > built-in default
```

```sh
fusionkit config show
fusionkit config get budgetUsd
fusionkit config set budgetUsd 5
fusionkit config set ensembles.default.judge deep
fusionkit config unset budgetUsd
fusionkit config edit

fusionkit ensemble add review \
  --member fast --member deep --judge deep --synthesizer deep
fusionkit ensemble edit review --member deep --judge deep
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

1. Move every provider/model URL/key/account definition into
   `.routekit/router.yaml`.
2. Assign each routed model a stable `endpointId`.
3. Replace each old panel with `members`, `judge`, and `synthesizer` endpoint
   IDs.
4. Set the config version to `fusionkit.fusion.v4` and add `router.config` or
   `router.url`.

The generated Python sidecar receives only endpoint IDs and the RouteKit gateway
URL. It receives no provider credential or provider configuration.
