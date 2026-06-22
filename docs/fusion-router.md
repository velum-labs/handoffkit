# FusionKit Claude Router (Phase 1)

Smart scenario-based routing for Claude Code, ported from [claude-code-router](https://github.com/musistudio/claude-code-router) (MIT). FusionKit inspects each request, picks one of five scenarios, and forwards it to the configured provider/model.

## Quick start

```bash
fusionkit fusion claude --route
```

Preview a routing decision without starting Claude or the gateway:

```bash
fusionkit fusion claude --route --route-dry-run --route-preview "explain this codebase"
```

Example output:

```
routing: scenario=default tokens=12 target=claude-sub,claude-sonnet-4-5 fallback=0 (standard request)
```

## Configuration

Add a `routing` section to `.fusionkit/fusion.json` at your repo root:

```json
{
  "version": "fusionkit.fusion.v2",
  "routing": {
    "routes": {
      "default": "claude-sub,claude-sonnet-4-5",
      "background": "claude-sub,claude-haiku-4-5",
      "longContext": "claude-sub,claude-sonnet-4-5",
      "longContextThreshold": 60000,
      "reasoning": "claude-sub,claude-opus-4-5",
      "webSearch": "claude-sub,claude-sonnet-4-5",
      "fallbacks": {
        "default": ["openai-sub,gpt-4o"]
      }
    },
    "providers": [
      {
        "id": "claude-sub",
        "provider": "anthropic",
        "keyEnv": "ANTHROPIC_API_KEY"
      },
      {
        "id": "openai-sub",
        "provider": "openai",
        "keyEnv": "OPENAI_API_KEY"
      }
    ]
  }
}
```

### Route targets

Each route value is either `providerId,modelId` or a bare `modelId`. Provider ids must match entries in `routing.providers`.

### Scenarios

| Scenario | When it applies |
| --- | --- |
| `webSearch` | Request includes web search / fetch tools |
| `reasoning` | Extended thinking (`thinking.budget_tokens`) or `reasoning_effort` |
| `longContext` | Token count exceeds `longContextThreshold` (default 60,000) |
| `background` | Background agent headers, markers, or model name |
| `default` | Everything else |

Priority order: `webSearch` → `reasoning` → `longContext` → `background` → `default`.

### Providers

Supported `provider` kinds: `anthropic`, `openai`, `google`, `openai-compatible`. API keys are read from env vars named in `keyEnv` — never stored in the config file.

When `routing.providers` is omitted, FusionKit can derive providers from the committed `panel` section (explicit routing providers win over panel-derived ones; local `mlx` panel entries are ignored).

### Per-repo overrides

Optional `.fusionkit/routing.override.json` shallow-merges route tables over `fusion.json` for project-specific tuning.

## CLI flags

| Flag | Description |
| --- | --- |
| `--route` | Start a routing gateway and launch Claude Code against it |
| `--route-dry-run` | Print the routing decision and exit (no network) |
| `--route-preview <text>` | Sample prompt for dry-run scenario detection |

## Phase scope

Phase 1 covers config integration, model-gateway routing, and the `fusionkit fusion claude --route` CLI. OpenRouter/DeepSeek/Groq/Gemini backends and the Scope dashboard UI are planned for later phases.
