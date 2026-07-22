# Subscription pooling

RouteKit owns subscription credentials, multi-account pools, provider relays,
account connectors, and their command surfaces. FusionKit v4 consumes the same
namespaced `provider/model` IDs that RouteKit advertises for API-key providers.

## One enrollment surface

Every subscription kind enrolls through the same command:

```sh
npm install -g @routekit/cli
routekit config init
routekit accounts login claude-code --name personal
routekit accounts login codex --name work
routekit accounts login gemini
routekit accounts status
routekit models list
```

`accounts login <kind>` resolves the connector that backs the kind, runs its
OAuth flow, enrolls the credential, enables the matching router provider, and
verifies live model discovery. `--no-browser` prefers a browserless flow
(Codex device code; copyable URL + pasted code elsewhere) so a headless host
only needs a browser on some other device. The first successful login
automatically enables the subscription provider in the effective router
config; `accounts remove`, `list`, and `status` operate uniformly across all
kinds.

## Connectors (implementation detail)

The registry (`spec/registry/connectors.json`) declares which mechanism backs
each kind. Users never install, serve, or configure a connector directly.

| Kind | Connector | Mechanism |
| --- | --- | --- |
| `claude-code` (alias `claude`) | native | Official CLI login in a private temporary profile; credential imported into RouteKit's native pool; provider-native relay. |
| `codex` | native | Same managed login; `--no-browser` runs `codex login --device-auth`. |
| `gemini` (alias `antigravity`) | cliproxy | OAuth via the RouteKit-managed CLIProxyAPI sidecar. |
| `grok` (alias `xai`) | cliproxy | Same. |
| `kimi` | cliproxy | Same. |

The native login runs the matching official CLI in a private temporary
profile, imports only that credential, and removes the temporary profile. It
never replaces the user's normal Claude Code or Codex login. Use
`accounts add <kind> --name <label>` only to import the current official CLI
login instead.

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
Failed accounts and accounts that omit the metadata are skipped. CLIProxy-backed
Gemini, Grok, and Kimi accounts expose one connector-aggregated catalog, so
RouteKit has no per-account capability conflict to merge on that path; the same
explicit configuration override still wins over that discovered catalog.

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

## The CLIProxyAPI connector

[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (MIT) is a local
proxy that fronts OAuth subscription accounts behind an OpenAI-compatible API
with multi-account rotation. RouteKit uses it as the connector for
subscription kinds it does not relay natively (Gemini via Antigravity, Grok,
Kimi) and represents it as the `cliproxy` router provider; models appear as
`cliproxy/<model>` in the live catalog and in Fusion ensembles:

```json
{
  "version": "fusionkit.fusion.v4",
  "router": { "config": ".routekit/router.yaml" },
  "ensembles": {
    "default": {
      "members": ["cliproxy/gemini-3.1-pro-preview", "openai/gpt-5.5"],
      "judge": "openai/gpt-5.5"
    }
  }
}
```

The whole lifecycle is RouteKit-owned:

- The first `accounts login` of a cliproxy-backed kind downloads the pinned,
  SHA-256-verified release into `~/.routekit/cliproxy/` (or `ROUTEKIT_HOME`)
  and generates a private `config.yaml` with the sidecar's ingress key; the
  binary, config, and OAuth `auth/` store are all 0600/0700. Commands never
  print credential values.
- The **daemon supervises the sidecar process**: it starts it whenever the
  `cliproxy` provider is configured, restarts it after a crash, stops it on
  daemon shutdown, and injects the managed ingress key and listen address into
  every router generation. There is no user-facing serve command.
- `routekit doctor` reports sidecar reachability; `accounts status` marks
  cliproxy-backed accounts `local-only`.

A self-managed CLIProxyAPI still works as a plain provider: export
`ROUTEKIT_CLIPROXY_API_KEY` (one of its `api-keys`) and, for a non-default
host/port, `ROUTEKIT_CLIPROXY_BASE_URL`. When that base-URL override is set,
the daemon never spawns its own sidecar.

### ToS caveat

CLIProxyAPI reuses subscription OAuth tokens through reverse-engineered
endpoints. Anthropic, OpenAI, Google, and xAI restrict reusing subscription
credentials in third-party tooling. Cliproxy-backed kinds are for
**personal/local use only** — the sidecar binds loopback, `accounts login`
warns before starting, and FusionKit never ships it as a hosted feature. Use
at your own risk. Prefer the native `claude-code` and `codex` connectors,
which use provider-native relays and quota-aware selection inside the
singleton daemon.

### Operational notes

- The release is pinned (`CLIPROXY_PINNED_VERSION` in
  `packages/accounts/src/cliproxy.ts`) and verified against the release's
  `checksums.txt`; upgrades are a deliberate pin bump, not implicit.
- Upstream endpoints can break when vendors change their private APIs; a
  broken member simply fails its panel slot (survivors are still fused), and
  direct API-key members are unaffected.
- The provider preset lives in `spec/registry/providers.json`
  (`providers.cliproxy`) and the connector map in
  `spec/registry/connectors.json`; regenerate bindings with
  `node scripts/generate-registry.mjs` after editing.
- The upstream source is vendored read-only at `references/cliproxyapi/`
  (pinned to the same commit as release v7.2.72, tracked via trackcn — see
  `references/THIRD_PARTY.md`), so the wire formats, OAuth flows, and rotation
  behavior we depend on can be studied and diffed offline when bumping the pin.

FusionKit links the reusable `@routekit/router` SDK for embedded composition;
it does not depend on `@routekit/cli` or execute `routekit`. `fusionkit stop`
only reaps Fusion-owned processes and portless routes. External RouteKit
daemons remain running.
