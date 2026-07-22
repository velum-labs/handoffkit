# Model catalog

Provider activation, live model discovery, and dispatch belong to RouteKit.
For FusionKit embedded mode, enable providers in `.routekit/router.yaml`; do
not copy individual models into configuration:

```yaml
providers:
  openai: {}
  anthropic: {}
  codex:
    strategy: capacity_weighted
    switchThreshold: 0.9
defaultModel: openai/gpt-5.5
```

Every configured provider authenticates and discovers models at startup.
RouteKit publishes the merged catalog with source-qualified IDs and strips the
source prefix before upstream egress:

```text
openai/gpt-5.5
anthropic/claude-sonnet-4-5
codex/gpt-5.5
openrouter/moonshotai/kimi-k2-thinking
```

The standalone RouteKit singleton instead owns
`~/.config/routekit/router.yaml`. It never discovers the project file by
working directory. To inspect a project policy through daemon-backed commands,
first replace the canonical document explicitly:

```sh
routekit config import --from .routekit/router.yaml
routekit providers status
routekit models list
```

Import validates and atomically replaces the complete document; it does not
merge project and global configuration. `fusionkit doctor` validates the
embedded project's catalog without importing it into the singleton.

```json
{
  "version": "fusionkit.fusion.v4",
  "router": { "config": ".routekit/router.yaml" },
  "ensembles": {
    "default": {
      "members": ["openai/gpt-5.5", "anthropic/claude-sonnet-4-5"],
      "judge": "anthropic/claude-sonnet-4-5"
    }
  }
}
```

Use models from different vendors or families when you want decorrelated
candidates. FusionKit validates every member, judge, and synthesizer against
the live RouteKit catalog. An unknown or unnamespaced model fails instead of
falling back to the router default.

Subscription providers use the same catalog. RouteKit unions discovery results
from all enrolled accounts, records per-model eligibility, and selects only
among healthy accounts that advertise the requested model.

## Native client pickers

Canonical RouteKit IDs remain namespaced everywhere. A matching native client
gets a door-local display alias so its own subscription models look normal:

- Claude Code lists `claude-code/claude-sonnet-4-6` as
  `claude-sonnet-4-6`.
- Codex lists `codex/gpt-5.5` as `gpt-5.5`.

Models owned by other providers stay source-qualified in either picker. Both a
bare picker alias and the corresponding namespaced ID resolve to the same
canonical catalog entry. The request then uses RouteKit's server-owned account
pool over the provider-native protocol. Bare IDs are not accepted by the
global OpenAI, Cursor, FusionKit, or configuration surfaces.

## Local MLX cache

FusionKit retains local-panel cache lifecycle commands:

```sh
fusionkit models
fusionkit models download mlx-community/Qwen3-1.7B-4bit
fusionkit models download <repo> --force
fusionkit models rm mlx-community/Qwen3-1.7B-4bit
```

`fusionkit models list` reports size, downloaded state, and a conservative RAM
floor. This local cache is separate from RouteKit's live provider catalog.
RouteKit currently accepts only its registry-backed provider IDs; use RouteKit
directly for single-model launches.
