# FusionKit Claude Router

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

Supported `provider` kinds: `anthropic`, `openai`, `google`, `google-gemini`, `openai-compatible`, `openrouter`, `deepseek`, `groq`. API keys are read from env vars named in `keyEnv` — never stored in the config file.

When `routing.providers` is omitted, FusionKit can derive providers from the committed `panel` section (explicit routing providers win over panel-derived ones; local `mlx` panel entries are ignored). The panel `google` provider maps to routing kind `google-gemini`.

#### OpenRouter

```json
{
  "id": "openrouter",
  "provider": "openrouter",
  "keyEnv": "OPENROUTER_API_KEY",
  "baseUrl": "https://openrouter.ai/api/v1",
  "defaultModel": "anthropic/claude-sonnet-4.6"
}
```

- **Base URL:** `https://openrouter.ai/api/v1` ([API Reference — Overview](https://openrouter.ai/docs/api-reference/overview))
- **Key env:** `OPENROUTER_API_KEY`
- **Rate limits:** tier-based credits; HTTP **429** when exceeded ([Chat Completion — Errors](https://openrouter.ai/docs/api-reference/chat-completion))
- **Context window:** model-dependent via OpenRouter catalog (resolve at route time)

#### DeepSeek

```json
{
  "id": "deepseek",
  "provider": "deepseek",
  "keyEnv": "DEEPSEEK_API_KEY",
  "baseUrl": "https://api.deepseek.com",
  "defaultModel": "deepseek-v4-pro"
}
```

- **Base URL:** `https://api.deepseek.com` (no `/v1` suffix; paths are `/chat/completions` per [Your First API Call](https://api-docs.deepseek.com/))
- **Key env:** `DEEPSEEK_API_KEY`
- **Rate limits:** concurrency-based; **429** when exceeded ([Rate Limit](https://api-docs.deepseek.com/quick_start/rate_limit))
- **Context window:** 1M tokens on `deepseek-v4-flash` and `deepseek-v4-pro` ([Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing))

#### Groq

```json
{
  "id": "groq",
  "provider": "groq",
  "keyEnv": "GROQ_API_KEY",
  "baseUrl": "https://api.groq.com/openai/v1",
  "defaultModel": "openai/gpt-oss-120b"
}
```

- **Base URL:** `https://api.groq.com/openai/v1` ([OpenAI Compatibility](https://console.groq.com/docs/openai))
- **Key env:** `GROQ_API_KEY`
- **Rate limits:** tier-based RPM/TPM per model; **429** with `retry-after` ([Rate Limits](https://console.groq.com/docs/rate-limits))
- **Context window:** 128K–131K for production chat models ([Models](https://console.groq.com/docs/models))

#### Google Gemini

```json
{
  "id": "google-gemini",
  "provider": "google-gemini",
  "keyEnv": "GEMINI_API_KEY",
  "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai/",
  "defaultModel": "gemini-2.5-flash"
}
```

- **Base URL:** `https://generativelanguage.googleapis.com/v1beta/openai/` ([OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai))
- **Key env:** `GEMINI_API_KEY` (same as panel `google`)
- **Rate limits:** tier-based (Free vs Paid); exact RPM/TPM per model on AI Studio ([Pricing](https://ai.google.dev/gemini-api/docs/pricing))
- **Context window:** 1M tokens on `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite` ([Pricing — Gemini 2.5 Flash](https://ai.google.dev/gemini-api/docs/pricing))

### Per-repo overrides

Optional `.fusionkit/routing.override.json` shallow-merges route tables over `fusion.json` for project-specific tuning.

## CLI flags

| Flag | Description |
| --- | --- |
| `--route` | Start a routing gateway and launch Claude Code against it |
| `--route-dry-run` | Print the routing decision and exit (no network) |
| `--route-preview <text>` | Sample prompt for dry-run scenario detection |

## Phase scope

Phase 1 covers config integration, model-gateway routing, and the `fusionkit fusion claude --route` CLI. Phase 2 adds OpenRouter, DeepSeek, Groq, and Google Gemini as first-class routing provider kinds (all via the existing OpenAI-compat backend). The Scope dashboard UI is planned for Phase 3.
