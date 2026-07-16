# Model catalog

Provider activation, live model discovery, and dispatch belong to RouteKit.
Enable providers in `.routekit/router.yaml`; do not copy individual models into
configuration:

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

Inspect the live catalog before composing those IDs in Fusion v4:

```sh
routekit providers status
routekit models list
```

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
