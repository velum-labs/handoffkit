# Subscription pooling

RouteKit owns subscription credentials, multi-account pools, CLIProxyAPI,
provider relays, and their command surfaces. FusionKit v4 consumes the same
namespaced `provider/model` IDs that RouteKit advertises for API-key providers.

```sh
npm install -g @routekit/cli
routekit config init
routekit accounts login claude-code --name personal
routekit accounts login claude-code --name work
routekit providers status claude-code
routekit models list
routekit serve
```

The canonical subscription kinds are `claude-code` and `codex`.
`accounts login` runs the matching official CLI login in a private temporary profile,
imports only that credential into RouteKit's native pool, and removes the
temporary profile. It never replaces the user's normal Claude Code or Codex
login. Use `accounts add <kind> --name <label>` only to import the current
official CLI login instead.

The Claude Code tool launcher remains `routekit claude [provider/model]`; there
is no `routekit claude-code` command. The first successful login or import
automatically enables the subscription provider in the effective router
config. Pool selection policy lives on that provider:

```yaml
providers:
  claude-code:
    strategy: capacity_weighted
    switchThreshold: 0.9
```

At startup RouteKit performs discovery against every healthy member and
publishes the union as `claude-code/<model>` or `codex/<model>`. Per-model
eligibility prevents a request from reaching an account that did not advertise
that model. Each member keeps independent credential refresh, quota windows,
rate-limit cooldowns, and reset times. `accounts status` reports all members
without exposing credentials.

Claude Code and Codex present their own subscription models under bare native
names in their `/model` pickers. This is only a client-facing alias:
`claude-sonnet-4-6` still resolves to
`claude-code/claude-sonnet-4-6`, and `gpt-5.5` in Codex still resolves to
`codex/gpt-5.5`. RouteKit then selects an eligible managed account and forwards
the unchanged provider-native request. The native relay is part of the
RouteKit-owned pooling path, not a bypass around it. Other clients and
configuration continue to use namespaced IDs.

Reference the advertised namespaced ID from `.fusionkit/fusion.json`. Do not
put account enrollment, provider policy, URLs, or keys in Fusion config.

Normal `routekit serve` and `routekit <tool>` paths use subscription backends
in process. `routekit accounts serve` is advanced mode for exposing the pool as
a separate authenticated proxy to an external consumer; it is not an
enrollment or provider-activation step.

CLIProxyAPI remains an optional external provider with a separate lifecycle:

```sh
routekit accounts cliproxy install
routekit accounts cliproxy login gemini
routekit accounts cliproxy serve
routekit providers add cliproxy
routekit providers status cliproxy
routekit models list
```

Login alone does not enable the `cliproxy` provider. Keep CLIProxyAPI serving,
enable the provider once, and select models from its live
`cliproxy/<model>` catalog.

FusionKit links the reusable `@routekit/router` SDK for embedded composition;
it does not depend on `@routekit/cli` or execute `routekit`. `fusionkit stop`
only reaps Fusion-owned processes and portless routes. External RouteKit
daemons remain running.
