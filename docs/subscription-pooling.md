# Subscription pooling

RouteKit owns subscription credentials, multi-account pools, provider relays,
account connectors, and their command surfaces. FusionKit v4 consumes the same
namespaced `provider/model` IDs that RouteKit advertises for API-key providers.

## One enrollment surface

Every subscription kind enrolls through the same command:

```sh
npm install -g @velum-labs/routekit
routekit config init --empty
routekit accounts login claude-code --name personal
routekit accounts login codex --name work
routekit accounts status
routekit models list
```

`--empty` creates the canonical config without an API-key provider so the
daemon can accept the first subscription login. Skip initialization when a
canonical config already exists.

`accounts login <kind>` accepts the first-launch `claude-code` and `codex`
kinds, runs the official CLI OAuth flow, enrolls the credential, enables the
matching router provider, and verifies live model discovery. `--no-browser`
prefers a browserless flow
(Codex device code; copyable URL + pasted code elsewhere) so a headless host
only needs a browser on some other device. The first successful login
automatically enables the subscription provider in the effective router
config; `accounts remove`, `list`, and `status` operate uniformly across all
kinds.

Enrollment and activation are one daemon-owned transaction. OAuth runs against
disposable profiles first; the authenticated daemon then commits every account
file, the provider config, both revisions, and the replacement router
generation together. A failure restores the exact prior local state. If the
daemon is interrupted after preparation, startup restores the private rollback
vault before loading config or starting the router.
Retries of an already committed account/provider pair are no-ops. Transaction
manifests contain paths, hashes, phases, and revision metadata only—credential
values remain in mode-`0600` opaque rollback files and are deleted after commit
or recovery.

## Supported connectors

The registry (`spec/registry/connectors.json`) declares which mechanism backs
each kind. Users never install, serve, or configure a connector directly.

| Kind | Connector | Mechanism |
| --- | --- | --- |
| `claude-code` (alias `claude`) | native | Official CLI login in a private temporary profile; credential imported into RouteKit's native pool; provider-native relay. |
| `codex` | native | Same managed login; `--no-browser` runs `codex login --device-auth`. |

The native login runs the matching official CLI in a private temporary
profile, imports only that credential, and removes the temporary profile. It
never replaces the user's normal Claude Code or Codex login. Use
`accounts add <kind> --name <label>` only to import the current official CLI
login instead.

Router startup never imports an official CLI login implicitly. This keeps the
daemon transaction as the sole RouteKit-owned enrollment write path.

Pool selection policy lives on the provider:

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
and connector health without exposing credentials.

Capability conflicts do not depend on network response timing. Explicit
`reasoningCapabilities` configuration has highest precedence. Otherwise, a
native pool uses the first successfully discovered account in configured order
that reports reasoning metadata for the model: directory-backed accounts are
ordered by account filename, and explicit account paths retain caller order.
Failed accounts and accounts that omit the metadata are skipped.

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

The singleton daemon owns subscription backends and exposes them through its
authenticated model gateway. There is no separate accounts-proxy lifecycle.

`routekit usage` and `routekit usage --watch <seconds>` inspect the normal
daemon's live pools.

## Internal implementation retention (non-contractual)

The neutral registry and daemon may retain additional provider and connector
implementations for compatibility, migration, and development. They are not
first-launch onboarding, are not qualified by L06, and do not create a public
support commitment. Do not infer RouteKit support from registry entries,
generated catalogs, package presence, or internal tests.

FusionKit links the reusable `@velum-labs/routekit-router` SDK for embedded composition;
it does not depend on `@velum-labs/routekit` or execute `routekit`. `fusionkit stop`
only reaps Fusion-owned processes and portless routes. External RouteKit
daemons remain running.
