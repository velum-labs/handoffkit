# CLIProxyAPI as a panel upstream (`cliproxy` provider)

[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (MIT) is a local
proxy that fronts OAuth **subscription** accounts — ChatGPT/Codex, Claude Code,
Gemini (Antigravity), Grok, Kimi — behind an OpenAI-compatible API, with
multi-account rotation. RouteKit owns the verified binary, private config, and
OAuth account store. RouteKit represents it as the explicit `cliproxy`
provider: a live OpenAI-compatible source whose credential is the proxy's own
ingress key. FusionKit references namespaced `cliproxy/<model>` IDs.

## Where it fits

Use native RouteKit `claude-code` and `codex` providers. They use
provider-native relays and quota-aware selection without a separate proxy
process. `routekit accounts serve` is only the advanced mode that exposes those
pools to an external consumer.

Reach for `cliproxy` when an ensemble needs a subscription provider RouteKit
does not support natively (Gemini, Grok, Kimi), or when you already run
CLIProxyAPI for another tool. CLIProxyAPI is a separate, URL-backed upstream.

## Quick start (managed sidecar)

```bash
routekit config init
routekit accounts cliproxy install         # pinned release, SHA-256 verified
routekit accounts cliproxy login gemini    # or claude / codex / grok / kimi / antigravity
routekit accounts cliproxy serve           # http://127.0.0.1:8317
```

The managed instance lives under `~/.routekit/cliproxy/` (or `ROUTEKIT_HOME`;
binary, `config.yaml`
with the generated ingress key, and the proxy's OAuth `auth/` store, all
0600/0700). Commands never print credential values. A self-managed CLIProxyAPI
works identically: export `ROUTEKIT_CLIPROXY_API_KEY` (one of its `api-keys`)
and, for a non-default host/port, `ROUTEKIT_CLIPROXY_BASE_URL`.

In another shell, enable the provider and inspect every model RouteKit
discovers:

```bash
routekit providers add cliproxy
routekit providers status cliproxy
routekit models list
routekit accounts cliproxy status
```

CLIProxy login never enables the RouteKit provider automatically. The
resulting `.routekit/router.yaml` entry is:

```yaml
providers:
  cliproxy: {}
```

## Use a live model in Fusion

Fusion v4 contains namespaced model IDs only:

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

Run `routekit providers status cliproxy` to probe the proxy-backed source.
`fusionkit doctor` validates that every namespaced model ID referenced by the
ensemble is available from RouteKit.

## ToS caveat

CLIProxyAPI reuses subscription OAuth tokens through reverse-engineered
endpoints. Anthropic, OpenAI, Google, and xAI restrict reusing subscription
credentials in third-party tooling. This integration is for **personal/local
use only** — the proxy binds loopback by default, and FusionKit never ships it
as a hosted feature. Use at your own risk.

## Operational notes

- The release is pinned (`CLIPROXY_PINNED_VERSION` in
  `packages/accounts/src/cliproxy.ts`) and verified against the release's
  `checksums.txt`; upgrades are a deliberate pin bump, not implicit.
- Upstream endpoints can break when vendors change their private APIs; a
  broken member simply fails its panel slot (survivors are still fused), and
  direct API-key members are unaffected.
- The registry preset lives in `spec/registry/providers.json`
  (`providers.cliproxy`); regenerate bindings with
  `node scripts/generate-registry.mjs` after editing.
- The upstream source is vendored read-only at `references/cliproxyapi/`
  (pinned to the same commit as release v7.2.72, tracked via trackcn — see
  `references/THIRD_PARTY.md`), so the wire formats, OAuth flows, and rotation
  behavior we depend on can be studied and diffed offline when bumping the pin.
