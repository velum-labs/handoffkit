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

DeepSeek outbound requests disable thinking mode by default (`extra_body.thinking.type: "disabled"`) so multi-turn tool loops do not require `reasoning_content` round-trips. Enable thinking explicitly in provider overrides only when you have verified end-to-end tool behavior.

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

Phase 1 covers config integration, model-gateway routing, and the `fusionkit fusion claude --route` CLI. Phase 2 adds OpenRouter, DeepSeek, Groq, and Google Gemini as first-class routing provider kinds (all via the existing OpenAI-compat backend). Phase 3A adds the Scope dashboard routing UI. Phase 3B adds AI-assisted routing onboarding in `fusionkit init`. Phase 4 wires provider error classification into the fallback loop, automatic scope decision publishing, and DeepSeek thinking-mode defaults.

### Fallback behavior

The routing gateway uses `classifyProviderError` before advancing the scenario fallback chain. HTTP **400** and **401** (client / auth errors) return immediately without trying fallbacks. **429**, **402**, **498**, **5xx**, and network failures advance to the next configured target when one exists.

## Dashboard

The local **scope** observability app (`apps/scope`) includes a read-only **Routing** section at `/routing`:

| Page | URL | Contents |
| --- | --- | --- |
| Overview | `/routing` | `fusion.json` routing summary + live decision stream (SSE) |
| Providers | `/routing/providers` | Provider table (kind, base URL, key env, connectivity ping) |
| Scenarios | `/routing/scenarios` | Five-scenario route table with primary targets and fallbacks |

### Commands

```bash
# Monorepo dev (from repo root)
cd apps/scope && pnpm install && pnpm dev

# Or via fusion observe (boots scope on port 4317)
fusionkit fusion --observe

# API smoke checks
curl -sf http://localhost:4317/api/routing/config
curl -sfN http://localhost:4317/api/routing/decisions   # event: routing.decision
```

Set `SCOPE_REPO_ROOT` when the dashboard cwd is not your git repo root (scope walks up for `.fusionkit/fusion.json` by default).

### Live decision stream

`GET /api/routing/decisions` is an SSE feed (`event: routing.decision`) backed by an in-process pub/sub ring buffer inside the scope server. When you run `fusionkit fusion claude --route`, each routing decision is best-effort POSTed to `http://127.0.0.1:4317/api/routing/decisions` so the dashboard live stream updates automatically.

Set `FUSION_ROUTING_SCOPE_PUBLISH=0` (or `false` / `off`) to disable publishing. Override the dashboard base URL with `FUSION_ROUTING_SCOPE_URL` (for example when scope runs on a non-default host). Publish failures are swallowed when the dashboard is not running — routing and the gateway keep working.

**Screenshot (overview):** sticky header “Routing”, left nav highlight on Routing, config summary card with JSON tree of `routing.providers` + `routing.routes`, right column “Live decisions” showing a card with scenario badge `default`, target `claude-sub,claude-sonnet-4-5`, token count, and reason line.

**Screenshot (providers):** table with five rows (`claude-sub`, `openrouter`, `deepseek`, `groq`, `google-gemini`) — kind badges, base URLs, key env names, key-present pills, connectivity column with ping latency or “key missing”.

**Screenshot (scenarios):** five-row table (`default`, `background`, `longContext`, `reasoning`, `webSearch`) with mono primary targets and fallback badges; longContext row notes the 60k token threshold.

## Onboarding

`fusionkit init` can scaffold a `routing` section in `.fusionkit/fusion.json` based on what is already on your machine.

### Trigger

During an interactive init, FusionKit asks:

1. **Add smart routing for Claude Code?** — opt-in (default: no). Skipping leaves `fusion.json` without a `routing` section.
2. When local MLX is available (Apple Silicon + provisioned runtime), **Use local AI assistant to propose routing?** — default: no. Choosing yes runs `mlx-community/Llama-3.2-1B-Instruct-4bit` locally to draft routes and providers from detected auth.

Pass **`--ai-routing`** to enable the routing step non-interactively and prefer the AI assistant when MLX is ready; otherwise deterministic defaults are written.

```bash
fusionkit init --ai-routing
```

### What gets detected (no secrets)

| Signal | Source |
| --- | --- |
| Claude Code subscription | `detectSubscription("claude-code")` |
| Codex subscription | `detectSubscription("codex")` |
| API keys | env presence only: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY` |
| Local MLX | same readiness probe as init's MLX onboarding (`ensureProvisioned` on Apple Silicon) |

### Deterministic fallback

When MLX is unavailable, the user declines the AI step, or the model returns invalid JSON twice, FusionKit proposes defaults from `docs/phase-2-providers.md` §3 — for example Claude Code subscription → `default: claude-sub,claude-sonnet-4-5` with `{ id: claude-sub, provider: anthropic }` (no `keyEnv`), or the first available API-key provider otherwise.

The proposal is shown before write; accept, edit the JSON, or skip. Init never blocks when routing setup fails.
