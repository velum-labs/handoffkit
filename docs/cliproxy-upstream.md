# CLIProxyAPI as a panel upstream (`cliproxy` provider)

[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (MIT) is a local
proxy that fronts OAuth **subscription** accounts — ChatGPT/Codex, Claude Code,
Gemini (Antigravity), Grok, Kimi — behind an OpenAI-compatible API, with
multi-account rotation. FusionKit consumes it as the `cliproxy` provider: a
plain OpenAI-compatible upstream whose "API key" is the proxy's own ingress
key. That puts subscription-backed frontier models (Gemini, Grok, Kimi — the
providers FusionKit has no native OAuth adapter for) on a fusion panel with
zero engine changes.

## Where it fits vs the built-in subscription proxy

| | built-in `fusionkit proxy serve` | `cliproxy` upstream |
|---|---|---|
| Providers | Claude Code, Codex | Codex, Claude Code, **Gemini/Antigravity, Grok, Kimi, …** |
| Wire | provider-native relays (Messages / Responses) | OpenAI Chat Completions |
| Rotation | quota-aware (sticky / round_robin / capacity_weighted) | round-robin (+ session affinity) |
| Owner | FusionKit (TypeScript, in-tree) | external Go binary (pinned release) |

Keep the built-in proxy as the default for Claude Code and Codex pooling — it
has quota-aware selection and native wire relays. Reach for `cliproxy` when a
panel wants providers FusionKit cannot OAuth natively (Gemini, Grok, Kimi),
or when you already run CLIProxyAPI for other tools.

## Quick start (managed sidecar)

```bash
fusionkit proxy cliproxy install         # pinned release, SHA-256 verified
export CLIPROXY_API_KEY=<printed ingress key>
fusionkit proxy cliproxy login gemini    # or claude / codex / grok / kimi / antigravity
fusionkit proxy cliproxy serve           # http://127.0.0.1:8317
fusionkit proxy cliproxy status          # install state, reachability, accounts
```

The managed instance lives under `~/.fusionkit/cliproxy/` (binary, `config.yaml`
with the generated ingress key, and the proxy's OAuth `auth/` store, all
0600/0700). A self-managed CLIProxyAPI works identically: export
`CLIPROXY_API_KEY` (one of its `api-keys`) and, for a non-default host/port,
`CLIPROXY_BASE_URL`.

## Panel members

`fusionkit init`'s panel builder offers **CLIProxyAPI (local proxy)** as an
auth choice; with `CLIPROXY_API_KEY` set, the model picker lists the proxy's
live `/v1/models` (the merged catalog of every account you logged in). In
`.fusionkit/fusion.json` a member looks like:

```json
{ "id": "gemini", "model": "gemini-3.1-pro-preview", "provider": "cliproxy" }
```

Or in a raw `fusionkit serve` YAML config:

```yaml
endpoints:
  - id: gemini
    provider: cliproxy
    model: gemini-3.1-pro-preview
    api_key_env: CLIPROXY_API_KEY
```

`base_url` defaults to `http://127.0.0.1:8317` (or `CLIPROXY_BASE_URL`).
Leave `pricing` unset: a subscription has no per-token billing, so cost
estimates stay "unknown" rather than reporting a wrong dollar amount.

`fusionkit doctor` probes the proxy (reachability + key) whenever
`CLIPROXY_API_KEY` is set or a configured panel references the provider.

## ToS caveat

CLIProxyAPI reuses subscription OAuth tokens through reverse-engineered
endpoints. Anthropic, OpenAI, Google, and xAI restrict reusing subscription
credentials in third-party tooling. This integration is for **personal/local
use only** — the proxy binds loopback by default, and FusionKit never ships it
as a hosted feature. Use at your own risk.

## Operational notes

- The release is pinned (`CLIPROXY_PINNED_VERSION` in
  `packages/cli/src/fusion/cliproxy.ts`) and verified against the release's
  `checksums.txt`; upgrades are a deliberate pin bump, not implicit.
- Upstream endpoints can break when vendors change their private APIs; a
  broken member simply fails its panel slot (survivors are still fused), and
  direct API-key members are unaffected.
- The registry preset lives in `spec/registry/providers.json`
  (`providers.cliproxy`); regenerate bindings with
  `node scripts/generate-registry.mjs` after editing.
