# Phase 2 Provider Backends — Research Spec

> Driving doc for Phase 2 of the FusionKit Claude Router. The implementing
> agent should read this end-to-end before touching code.

## 1. Goals

Phase 2 adds **OpenRouter**, **DeepSeek**, **Groq**, and **Google Gemini** as first-class provider backends in the Claude Router routing engine. Each backend is reached through the existing `OpenAiBackend` thin `fetch` wrapper in `packages/model-gateway/src/backend.ts`, which POSTs OpenAI-shaped Chat Completions bodies to a provider `baseUrl` and pipes the upstream `Response` (JSON or SSE) straight through to the `anthropic.ts` adapter chain (`Anthropic Messages → OpenAI Chat → provider`). The router already aliases non-Anthropic models for Claude Code's `/model` picker (`claudeModelAlias` in `packages/model-gateway/src/adapters/anthropic.ts`); Phase 2's job is to wire scenario-aware model selection and fallback across these four new providers plus the existing **Claude Code** and **Codex** subscription panel (`PanelAuthMode` in `packages/cli/src/fusion/subscriptions.ts`). Sensible per-scenario defaults (see §3) minimize config for the common case; a ordered fallback chain (see §6) covers rate limits, transient 5xx, and network failures without abandoning the user's session.

---

## 2. Provider Matrix

### OpenRouter

- **Homepage:** https://openrouter.ai/
- **API docs:** https://openrouter.ai/docs/api-reference/overview · https://openrouter.ai/docs/api-reference/chat-completion · https://openrouter.ai/docs/guides/features/tool-calling
- **OpenAI-compatible:** **yes** — OpenRouter explicitly states its request/response schemas are "very similar to the OpenAI Chat API" and normalizes across models/providers ([API Reference — Overview](https://openrouter.ai/docs/api-reference/overview)).
- **Base URL:** `https://openrouter.ai/api/v1`
- **Auth:** `Authorization: Bearer <key>` — env var suggestion: `OPENROUTER_API_KEY`. Optional attribution headers: `HTTP-Referer`, `X-OpenRouter-Title` ([Overview — Headers](https://openrouter.ai/docs/api-reference/overview)).
- **Streaming:** **OpenAI-compat SSE.** Set `stream: true`; response uses `chat.completion.chunk` objects with `choices[].delta`. OpenRouter may inject SSE **comment** payloads (`: ...`) that clients must ignore ([Overview — Server-Sent Events](https://openrouter.ai/docs/api-reference/overview)). Usage is emitted once in the final chunk before `[DONE]` when streaming.
- **Tool calling:** **supported**, OpenAI shape (`tools`, `tool_choice`, `tool_calls` on assistant messages, `role: "tool"` with `tool_call_id`). OpenRouter standardizes tool calling across upstream providers ([Tool Calling guide](https://openrouter.ai/docs/guides/features/tool-calling)). Supports `parallel_tool_calls` (provider-dependent passthrough).
- **Context window:** **model-dependent** via OpenRouter catalog; examples from live `/api/v1/models` (2026-06-22): `google/gemini-2.5-pro` 1,048,576; `anthropic/claude-sonnet-4.6` 1,000,000; `deepseek/deepseek-v3.2` 131,072; `z-ai/glm-5.2` 1,048,576. Always resolve from model metadata at route time — do not hard-code.
- **Pricing tier (rough):** **$$** — flagship passthrough example: `anthropic/claude-sonnet-4.6` ≈ **$3.00 / 1M input tokens** (OpenRouter catalog, 2026-06-22). OpenRouter adds a platform fee on top of upstream; exact `usage.cost` is returned per response when available ([Overview — ResponseUsage](https://openrouter.ai/docs/api-reference/overview)).
- **Rate limits:** **Tier-based credits.** Documented HTTP errors include **429** Too Many Requests ([Chat Completion — Errors](https://openrouter.ai/docs/api-reference/chat-completion)). Account-level credit balance; insufficient credits return **402** Payment Required. No uniform public RPM table — limits vary by account tier and model; treat 429 as rate-limit signal.
- **Notable models (3–5):**
  | Model id | Strength |
  | --- | --- |
  | `anthropic/claude-sonnet-4.6` | Best general coding/reasoning via subscription-grade Sonnet; 1M context on OR |
  | `google/gemini-2.5-pro` | 1M context, strong multimodal + grounding when routed to Google |
  | `google/gemini-2.5-flash` | Fast 1M-context workhorse; cheaper than Pro |
  | `deepseek/deepseek-v3.2` | Low-cost coding; direct DeepSeek API has newer v4 ids — see Open Questions |
  | `openai/gpt-5.2` | Frontier OpenAI when user has no Codex subscription |
- **OpenAI-Chat-translation gotchas:**
  - **OpenRouter-only fields** (`provider`, `models`, `route`, `plugins`, `reasoning`, `session_id`, `cache_control`) are stripped or transformed upstream; safe to omit from FusionKit's outbound body unless a scenario explicitly needs them (e.g. `webSearch` → `plugins: [{id:"web"}]`).
  - **Response extras:** `native_finish_reason`, `openrouter_metadata`, `usage.cost`, `usage.completion_tokens_details.reasoning_tokens` — the `anthropic.ts` adapter ignores these today; no break, but reasoning tokens are invisible to Claude Code unless explicitly forwarded.
  - **`max_tokens` vs `max_completion_tokens`:** OpenRouter accepts both; some providers enforce minimum 16 on `max_completion_tokens` ([Chat Completion](https://openrouter.ai/docs/api-reference/chat-completion)).
  - **Tool schema variance:** OpenRouter may transform tools to YAML for non-OpenAI providers ([Overview](https://openrouter.ai/docs/api-reference/overview)); tool-call error rates vary by model ([Tool Calling — Reliability Tracking](https://openrouter.ai/docs/guides/features/tool-calling)).
  - **SSE comments:** Parser must skip `: keep-alive` comment lines (same class of issue as DeepSeek keep-alive).
  - **Model id format:** Always `provider/model` (e.g. `anthropic/claude-sonnet-4.6`), not bare `claude-sonnet-4.6`.
- **Subscription-style auth?** **no** — OpenRouter is prepaid credits / pay-as-you-go. No consumer subscription that bypasses per-token billing comparable to Claude Code or Codex OAuth.

#### OpenRouter — additional reference

**Endpoints used by `OpenAiBackend`:**

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/chat/completions` | Primary router path |
| GET | `/models` | Model discovery (optional; router may use static scenario tables) |
| GET | `/generation?id=...` | Async cost/stats audit ([Overview — Querying Cost](https://openrouter.ai/docs/api-reference/overview)) |

**OpenRouter-specific request knobs (optional per scenario):**

| Field | Use in FusionKit |
| --- | --- |
| `provider.sort` / `provider.order` | Prefer ZDR or low-latency hosts ([Provider Selection](https://openrouter.ai/docs/guides/routing/provider-selection)) |
| `models` + `route: "fallback"` | Intra-OR model fallback before cross-provider fallback |
| `plugins: [{id:"web"}]` | `webSearch` scenario |
| `plugins: [{id:"response-healing"}]` | Harden JSON tool outputs |
| `reasoning` / `reasoning_effort` | `reasoning` scenario when upstream is a reasoning model |
| `session_id` | Sticky routing / cache affinity across a Claude Code session |

**Streaming parser requirements:** OpenRouter documents that SSE streams may include comment lines (lines starting with `:`) that must be ignored ([Overview — SSE](https://openrouter.ai/docs/api-reference/overview)). The gateway's `openAiSseToAnthropic` consumer should filter these before `JSON.parse` on `data:` lines. Same pattern as DeepSeek `: keep-alive` comments.

**Error HTTP status codes (from Chat Completion reference):** 400, 401, 402, 403, 404, 408, 413, 422, 429, 500, 502, 503 — all candidates for `classifyProviderError` ([Chat Completion — Errors](https://openrouter.ai/docs/api-reference/chat-completion)).

---

### DeepSeek

- **Homepage:** https://www.deepseek.com/
- **API docs:** https://api-docs.deepseek.com/ · https://api-docs.deepseek.com/guides/function_calling · https://api-docs.deepseek.com/guides/thinking_mode
- **OpenAI-compatible:** **yes** — "The DeepSeek API uses an API format compatible with OpenAI/Anthropic" ([Your First API Call](https://api-docs.deepseek.com/)).
- **Base URL:** `https://api.deepseek.com` (note: **no** `/v1` suffix — paths are `/chat/completions` directly per official curl examples). `OpenAiBackend` must use `baseUrl: "https://api.deepseek.com"` so `joinPath` yields `https://api.deepseek.com/chat/completions`.
- **Auth:** `Authorization: Bearer <key>` — env var suggestion: `DEEPSEEK_API_KEY`.
- **Streaming:** **OpenAI-compat SSE** with extra keep-alive behavior. Non-streaming responses may include continuous empty lines; streaming may emit SSE comments `: keep-alive` during long inference ([Rate Limit — Request Keep-Alive](https://api-docs.deepseek.com/quick_start/rate_limit)). SSE parser must tolerate both.
- **Tool calling:** **supported**, OpenAI shape. Documented in [Function Calling](https://api-docs.deepseek.com/guides/function_calling). **Thinking mode + tools:** when tools are used, `reasoning_content` on assistant messages **must** be round-tripped on subsequent turns or API returns **400** ([Thinking Mode — Tool Calls](https://api-docs.deepseek.com/guides/thinking_mode)).
- **Context window:** **1M tokens** for `deepseek-v4-flash` and `deepseek-v4-pro` ([Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)). Max output up to **384K**.
- **Pricing tier (rough):** **$** — flagship `deepseek-v4-pro`: **$0.435 / 1M input (cache miss)**, $0.87 / 1M output ([Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)). `deepseek-v4-flash` is cheaper ($0.14 / 1M input cache miss).
- **Rate limits:** **Concurrency-based (account level).** `deepseek-v4-pro`: 500 concurrent requests; `deepseek-v4-flash`: 2500 ([Rate Limit & Isolation](https://api-docs.deepseek.com/quick_start/rate_limit)). Exceeded → **HTTP 429**. Optional `user_id` field (via `extra_body` in OpenAI SDK) for per-user isolation on expanded accounts.
- **Notable models (3–5):**
  | Model id | Strength |
  | --- | --- |
  | `deepseek-v4-pro` | Flagship reasoning + tools; thinking mode default-on |
  | `deepseek-v4-flash` | Cheaper 1M-context workhorse; thinking toggle |
  | `deepseek-chat` | **Deprecated 2026-07-24** → maps to v4-flash non-thinking |
  | `deepseek-reasoner` | **Deprecated 2026-07-24** → maps to v4-flash thinking |
- **OpenAI-Chat-translation gotchas:**
  - **`reasoning_content` field** on assistant messages (thinking mode) — not part of stock OpenAI; `anthropic.ts` does not emit or preserve it. **High risk** for multi-turn tool loops: DeepSeek requires full `reasoning_content` passthrough when tools were called ([Thinking Mode — Tool Calls](https://api-docs.deepseek.com/guides/thinking_mode)). Phase 2 likely needs a DeepSeek-specific outbound serializer or thinking disabled for router paths until verified.
  - **`thinking` toggle** via `extra_body: {"thinking": {"type": "enabled|disabled"}}` — not expressible in plain OpenAI Chat without `extra_body` support in `OpenAiBackend`.
  - **`reasoning_effort`** supported (`high`/`max`; `low`/`medium` map to `high`) — overlaps with thinking config ([Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)).
  - **Sampling params ignored in thinking mode:** `temperature`, `top_p`, `presence_penalty`, `frequency_penalty` silently no-op ([Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)).
  - **Strict tool mode (beta):** requires `base_url="https://api.deepseek.com/beta"` and `strict: true` on functions ([Function Calling — strict Mode](https://api-docs.deepseek.com/guides/function_calling)) — separate base URL; do not enable by default.
  - **Legacy model names** on OpenRouter (`deepseek/deepseek-chat`) may not match direct API `deepseek-v4-*` ids — verify catalog parity (Open Questions).
- **Subscription-style auth?** **no** — API key + prepaid balance only ([Error 402 — Insufficient Balance](https://api-docs.deepseek.com/quick_start/error_codes)). No consumer subscription bypass.

#### DeepSeek — additional reference

**Dual API formats:** DeepSeek exposes both OpenAI Chat (`https://api.deepseek.com`) and Anthropic Messages (`https://api.deepseek.com/anthropic`) ([Your First API Call](https://api-docs.deepseek.com/)). Phase 2 should use **OpenAI format only** to reuse `OpenAiBackend` + `anthropic.ts` — do not add a second Anthropic-native backend unless translation risk proves unacceptable.

**Thinking mode defaults:** Thinking is **enabled by default** on v4 models ([Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)). For `background` scenario, explicitly disable via `extra_body: {"thinking": {"type": "disabled"}}` on `deepseek-v4-flash` to avoid reasoning latency/token cost.

**Cache pricing:** Prompt cache hit pricing is dramatically lower ($0.0028–$0.003625 / 1M input on v4) ([Pricing](https://api-docs.deepseek.com/quick_start/pricing)). Router does not need to implement cache breakpoints in Phase 2, but long Claude Code sessions may benefit from OpenRouter-style cache hints on other providers — not supported on DeepSeek OpenAI API beyond their automatic caching.

**FIM / prefix completion (beta):** `base_url=https://api.deepseek.com/beta` enables Fill-in-the-Middle — out of scope for Claude Router.

**Agent integration note:** DeepSeek documents first-class support for Claude Code / OpenCode as agent clients ([Your First API Call — Agent Integrations](https://api-docs.deepseek.com/)). Expect agent-class traffic patterns (long tool loops, thinking on) when users point Claude Code at a DeepSeek-backed gateway.

---

### Groq

- **Homepage:** https://groq.com/
- **API docs:** https://console.groq.com/docs/openai · https://console.groq.com/docs/tool-use · https://console.groq.com/docs/models
- **OpenAI-compatible:** **partial** — "mostly compatible with OpenAI's client libraries" with explicit unsupported fields ([OpenAI Compatibility](https://console.groq.com/docs/openai)).
- **Base URL:** `https://api.groq.com/openai/v1`
- **Auth:** `Authorization: Bearer <key>` — env var suggestion: `GROQ_API_KEY`.
- **Streaming:** **OpenAI-compat SSE** — standard `stream: true` pattern per OpenAI SDK examples on Groq docs. **needs runtime verification** for `tool_calls` delta indexing across all listed models.
- **Tool calling:** **supported** (local/function calling), OpenAI shape per [Tool Use](https://console.groq.com/docs/tool-use). **Caveats:** parallel tool support is **model-dependent** (e.g. `openai/gpt-oss-120b`: parallel **No**; `llama-3.3-70b-versatile`: parallel **Yes** — [Tool Use — Supported Models](https://console.groq.com/docs/tool-use)). `groq/compound` / `groq/compound-mini` use **built-in** server-side tools, not local `tools[]` — different code path.
- **Context window:** **128K–131K** for production chat models ([Models — Production](https://console.groq.com/docs/models)). Not a long-context provider.
- **Pricing tier (rough):** **$** — flagship `openai/gpt-oss-120b`: **$0.15 / 1M input**, $0.60 / 1M output ([Models](https://console.groq.com/docs/models)). `llama-3.1-8b-instant` is cheaper ($0.05 / 1M input) for background tier.
- **Rate limits:** **Tier-based (organization level).** Documented per-model RPM/TPM on [Rate Limits](https://console.groq.com/docs/rate-limits) and [Models](https://console.groq.com/docs/models). Example (Developer plan): `llama-3.3-70b-versatile` 30 RPM / 12K TPM; `openai/gpt-oss-120b` 30 RPM / 8K TPM. Exceeded → **429** with `retry-after` header. Custom **498** Flex Tier Capacity Exceeded ([Errors](https://console.groq.com/docs/errors)).
- **Notable models (3–5):**
  | Model id | Strength |
  | --- | --- |
  | `openai/gpt-oss-120b` | Best quality on Groq; ~500 t/s; built-in tools on 120B/20B |
  | `llama-3.3-70b-versatile` | Strong open-weight; parallel tools |
  | `llama-3.1-8b-instant` | Ultra-fast/cheap background model (~560 t/s) |
  | `groq/compound` | Agentic system with server-side web search + code exec (single-call) |
  | `qwen/qwen3-32b` | Preview; tool + parallel support |
- **OpenAI-Chat-translation gotchas:**
  - **Unsupported request fields → 400:** `logprobs`, `logit_bias`, `top_logprobs`, `messages[].name`; `n` must be 1 ([OpenAI Compatibility](https://console.groq.com/docs/openai)).
  - **`temperature: 0`** silently coerced to `1e-8` ([OpenAI Compatibility](https://console.groq.com/docs/openai)).
  - **No Groq models on OpenRouter** (verified 2026-06-22) — Groq is direct-only; do not route `groq,*` targets through OpenRouter.
  - **Compound models** ignore client-side `tools[]` — web search is internal; not equivalent to OpenRouter `plugins` or Gemini `google_search`.
  - **Error shape:** `{"error":{"message":"...","type":"invalid_request_error"}}` ([Errors](https://console.groq.com/docs/errors)) — maps cleanly to fallback detection.
- **Subscription-style auth?** **no** — API key with free-tier + Developer plan rate limits. No OAuth/subscription bypass like Claude Code/Codex.

#### Groq — additional reference

**Explicitly unsupported OpenAI Chat fields** (send → 400):

| Field | Mitigation in router |
| --- | --- |
| `logprobs` | Strip on outbound Groq requests |
| `logit_bias` | Strip |
| `top_logprobs` | Strip |
| `messages[].name` | Strip (rare in Claude Code traffic) |
| `n` > 1 | Never set |

**Built-in tools (Groq Compound):** `groq/compound` and `groq/compound-mini` run web search and code execution **server-side** in a single API call ([Tool Use — Built-In Tools](https://console.groq.com/docs/tool-use)). This is attractive for `webSearch` fallback but **incompatible** with Claude Code's local tool execution model unless the router detects Compound routes and suppresses client-side tool orchestration — **do not** wire Compound as a transparent drop-in for `default`.

**Remote MCP on Groq:** Groq supports MCP server-side tool execution ([Tool Use — Remote MCP](https://console.groq.com/docs/tool-use)). Out of scope for Phase 2 but shares the same "server-side tools vs Claude Code local tools" tension as Compound.

**Preview vs production models:** Preview models may be discontinued with short notice ([Models — Preview](https://console.groq.com/docs/models)). Prefer production models in committed `fusion.json` defaults.

---

### Google Gemini

- **Homepage:** https://ai.google.dev/
- **API docs:** https://ai.google.dev/gemini-api/docs/openai · https://ai.google.dev/gemini-api/docs/function-calling · https://ai.google.dev/gemini-api/docs/google-search
- **OpenAI-compatible:** **partial (beta)** — "Support for the OpenAI libraries is still in beta while we extend feature support" ([OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)). Core chat completions, streaming, tools, images, embeddings documented.
- **Base URL:** `https://generativelanguage.googleapis.com/v1beta/openai/`
- **Auth:** `Authorization: Bearer <key>` — env var suggestion: `GEMINI_API_KEY` (matches existing `defaultKeyEnv` for `google` in `packages/cli/src/fusion/env.ts`). Native Gemini REST also accepts `x-goog-api-key` header; OpenAI compat path uses Bearer.
- **Streaming:** **OpenAI-compat SSE** documented ([OpenAI compatibility — Streaming](https://ai.google.dev/gemini-api/docs/openai)). **needs runtime verification** for tool-call streaming and thinking token interleaving.
- **Tool calling:** **supported** via OpenAI `tools` / `tool_choice` in compat layer ([OpenAI compatibility — Function calling](https://ai.google.dev/gemini-api/docs/openai)). Native API uses `functionDeclarations` with per-call `id` on Gemini 3+ ([Function calling](https://ai.google.dev/gemini-api/docs/function-calling)) — compat layer should map to OpenAI `tool_calls`; **needs runtime verification** for id round-trip through `anthropic.ts`.
- **Context window:** **1M tokens** for `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite` ([Pricing — Gemini 2.5 Flash](https://ai.google.dev/gemini-api/docs/pricing)). `gemini-3.5-flash` and other Gemini 3.x models per [Models](https://ai.google.dev/gemini-api/docs/models).
- **Pricing tier (rough):** **$$** — flagship `gemini-2.5-pro`: **$1.25 / 1M input** (prompts ≤200K), $10 / 1M output ([Pricing — Gemini 2.5 Pro](https://ai.google.dev/gemini-api/docs/pricing)). `gemini-2.5-flash` is cheaper ($0.30 / 1M input). Tiered pricing above 200K input tokens.
- **Rate limits:** **Tier-based** (Free vs Paid vs Enterprise) — separate RPM/TPM per model on AI Studio; **needs runtime verification** for exact numbers (rate-limits doc timed out during research). Free tier has restricted model access ([Pricing — Free tier](https://ai.google.dev/gemini-api/docs/pricing)).
- **Notable models (3–5):**
  | Model id | Strength |
  | --- | --- |
  | `gemini-2.5-pro` | 1M context; best reasoning/coding in 2.5 family |
  | `gemini-2.5-flash` | 1M context; fast + thinking budgets |
  | `gemini-2.5-flash-lite` | Cheapest 1M-context option |
  | `gemini-3.5-flash` | Latest fast frontier; Google Search grounding |
  | `gemini-3.1-flash-lite` | High-volume agentic tasks, low cost |
- **OpenAI-Chat-translation gotchas:**
  - **Gemini-only features via `extra_body`:** `thinking_config`, `cached_content`, `google_search` grounding, `safety_settings` ([OpenAI compatibility — extra_body table](https://ai.google.dev/gemini-api/docs/openai)). Standard OpenAI Chat fields alone cannot enable web grounding — `webSearch` scenario must inject `extra_body.google` or use native `google_search` tool shape.
  - **`reasoning_effort` vs `thinking_level` / `thinking_budget`:** mutually exclusive mappings per model generation ([OpenAI compatibility — Thinking](https://ai.google.dev/gemini-api/docs/openai)). Sending both is an error — router must pick one knob per model family.
  - **Thinking cannot be disabled** on Gemini 2.5 Pro / Gemini 3 models ([OpenAI compatibility — Thinking](https://ai.google.dev/gemini-api/docs/openai)).
  - **Image / multimodal:** OpenAI `image_url` content parts supported ([OpenAI compatibility — Image understanding](https://ai.google.dev/gemini-api/docs/openai)); `anthropic.ts` already maps Anthropic image blocks → `image_url` — should work, **needs runtime verification**.
  - **Grounding response shape:** native `groundingMetadata` is not OpenAI `annotations`; OpenAI compat may not surface `url_citation` annotations — web results may appear only in plain `content` ([Google Search grounding](https://ai.google.dev/gemini-api/docs/google-search)).
  - **Batch API:** OpenAI batch upload/download not supported via compat ([OpenAI compatibility — Batch API](https://ai.google.dev/gemini-api/docs/openai)) — out of scope for router.
  - **Beta disclaimer:** parameter support gaps likely; treat compat as partial.
- **Subscription-style auth?** **no (for API router purposes)** — Gemini API keys from Google AI Studio are metered (Free/Paid tiers). Google One / Gemini consumer subscriptions do not provide the same OAuth bypass as Claude Code/Codex for arbitrary API routing. Users may have free-tier keys with different limits, but billing is still quota/token based.

#### Google Gemini — additional reference

**Relationship to existing `google` panel provider:** `packages/cli/src/fusion/env.ts` already lists `google` with `GEMINI_API_KEY`. Phase 2's `google-gemini` routing kind should share the same env var and base URL defaults. The panel's FusionKit Python `serve-endpoint` shim and the TypeScript router `OpenAiBackend` are parallel front doors — avoid duplicating keys under different env names.

**OpenAI compatibility surface (documented):**

| Feature | OpenAI compat support | Notes |
| --- | --- | --- |
| Chat completions | Yes | Core path |
| Streaming | Yes | [Streaming](https://ai.google.dev/gemini-api/docs/openai) |
| Function calling | Yes | [Function calling](https://ai.google.dev/gemini-api/docs/openai) |
| Image input | Yes | `image_url` parts |
| Audio / video / PDF | Partial | May need native API — **needs runtime verification** |
| Embeddings | Yes | Separate endpoint |
| Batch | Partial | Upload/download not in compat |
| `service_tier` (`flex` / `priority`) | Yes | Maps to Gemini inference tiers |

**Grounding / web search:** Native API uses `tools: [{ "google_search": {} }]` on `generateContent` ([Google Search](https://ai.google.dev/gemini-api/docs/google-search)). OpenAI compat layer documents `extra_body` for Gemini-specific tools ([OpenAI compatibility — extra_body](https://ai.google.dev/gemini-api/docs/openai)). Exact Chat Completions mapping for `webSearch` scenario is **not fully documented** — treat as Open Question.

**Thinking / reasoning mapping (OpenAI → Gemini):**

| OpenAI `reasoning_effort` | Gemini 3.1 Pro `thinking_level` | Gemini 2.5 `thinking_budget` |
| --- | --- | --- |
| `minimal` / `low` | `low` | 1,024 |
| `medium` | `medium` | 8,192 |
| `high` | `high` | 24,576 |

(Source: [OpenAI compatibility — Thinking](https://ai.google.dev/gemini-api/docs/openai))

**Context pricing cliff:** `gemini-2.5-pro` doubles input/output price above 200K prompt tokens ([Pricing — 2.5 Pro](https://ai.google.dev/gemini-api/docs/pricing)). `longContext` scenario should log token estimate warnings above 200K when billing awareness matters.

---

## 3. Recommended Defaults per Scenario

Routing scenarios align with the planned Claude Router scenario keys: `default`, `background`, `longContext`, `reasoning`, `webSearch`. Model targets use `provider,model` tuples (provider kind from §4, model id as required by that provider).

| Scenario | Primary | Fallback 1 | Fallback 2 | Why |
| --- | --- | --- | --- | --- |
| `default` | `claude-code,claude-sonnet-4-5` | `openrouter,anthropic/claude-sonnet-4.6` | `google-gemini,gemini-2.5-flash` | Subscription Sonnet first (zero marginal API cost for Pro users); OR passthrough if no auth; Gemini flash for cost/speed |
| `background` | `groq,llama-3.1-8b-instant` | `deepseek,deepseek-v4-flash` | `google-gemini,gemini-2.5-flash-lite` | Optimize latency/cost for low-stakes tasks; Groq 8B is fastest/cheapest; DeepSeek flash 1M ctx; Gemini lite as wide fallback |
| `longContext` | `google-gemini,gemini-2.5-pro` | `openrouter,google/gemini-2.5-pro` | `openrouter,anthropic/claude-sonnet-4.6` | Gemini 2.5 Pro: native 1M context at moderate cost; OR duplicate for users without `GEMINI_API_KEY`; Sonnet 1M as quality fallback |
| `reasoning` | `deepseek,deepseek-v4-pro` | `openrouter,anthropic/claude-sonnet-4.6` | `codex,gpt-5.5` | DeepSeek v4 Pro thinking mode is cheapest deep-reasoning API; Sonnet/Codex subs for users with logins |
| `webSearch` | `openrouter,anthropic/claude-sonnet-4.6` + `plugins:[web]` | `google-gemini,gemini-2.5-flash` + `extra_body google_search` | `groq,groq/compound` | OR web plugin unifies search across providers; Gemini native grounding via `extra_body`; Groq Compound for single-call agentic search |

**Implementation notes for defaults:**

- `claude-code,*` and `codex,*` targets use `auth` subscription path (no `keyEnv`) per `packages/cli/src/fusion/subscriptions.ts`.
- `webSearch` on OpenRouter requires outbound `plugins: [{ "id": "web" }]` or model suffix `:online` ([Web Search](https://openrouter.ai/docs/guides/features/web-search)) — implement as scenario-level request mutation, not a separate provider.
- `webSearch` on Gemini requires `extra_body` injection — not expressible in `OpenAiBackend` without Phase 2 extending request options.
- Deprecate `deepseek-chat` / `deepseek-reasoner` defaults before **2026-07-24** ([DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing)).

### Scenario selection heuristics (for auto-routing logic)

When the router must infer scenario from an inbound Claude Code request (before explicit user override):

| Signal | Scenario |
| --- | --- |
| User `/model` alias or router config pin | Use configured scenario for that alias |
| Estimated prompt tokens > 180K | `longContext` |
| Request tagged `background: true` (future harness hint) | `background` |
| User enables web / search / browse mode (future harness hint) | `webSearch` |
| Model name contains `reason`, `think`, `r1`, or effort hint | `reasoning` |
| Default | `default` |

Token estimation can reuse `handleCountTokens` in `anthropic.ts` (heuristic, not provider-precise) until a provider-native counter is wired.

### Subscription vs API-key precedence

For targets prefixed `claude-code` or `codex`:

1. Call `detectSubscription(mode)` from `packages/cli/src/fusion/subscriptions.ts`.
2. If `available && !expired`, route through FusionKit subscription auth (no `keyEnv`).
3. If unavailable, **skip** that target and proceed to API-key fallbacks without failing the request.

This prevents hard failure when a user's `fusion.json` lists `claude-code` primary but they only have `OPENROUTER_API_KEY` set.

---

## 4. Auth & Config Schema Additions

### Existing patterns (do not break)

`OpenAiBackend` (`packages/model-gateway/src/backend.ts`) expects:

```typescript
type OpenAiBackendOptions = {
  baseUrl: string;      // includes API prefix where applicable
  apiKey?: string;      // defaults to "not-needed"
  defaultModel?: string;
};
```

Panel layer (`packages/cli/src/fusion/env.ts`) already maps `google` → `GEMINI_API_KEY`. Phase 2 adds **routing provider kinds** distinct from panel `PanelProvider` (which remains `mlx | openai | anthropic | google | openai-compatible`).

### Proposed `RoutingProviderSpec`

Mirror the planned `packages/model-gateway/src/routing/providers.ts` shape:

```typescript
export type RoutingProviderKind =
  | "openrouter"
  | "deepseek"
  | "groq"
  | "google-gemini"
  // existing / Phase 1
  | "openai"
  | "anthropic"
  | "openai-compatible"
  | "mlx";

export type RoutingProviderSpec = {
  /** Provider discriminator — selects backend factory + default baseUrl */
  provider: RoutingProviderKind;
  /** Env var name holding the API key (never the secret itself) */
  keyEnv: string;
  /** Override base URL; omit to use provider default */
  baseUrl?: string;
  /** Default model when scenario omits one */
  defaultModel?: string;
};
```

Subscription targets (`claude-code`, `codex`) remain on **scenario model tuples** via `auth` on panel specs, not in `routing.providers`.

### `.fusionkit/fusion.json` additions

New top-level `routing` object (orthogonal to existing `panel` / `judgeModel` in `packages/cli/src/fusion-config.ts`):

```json
{
  "version": "fusionkit.fusion.v2",
  "routing": {
    "providers": {
      "openrouter": {
        "provider": "openrouter",
        "keyEnv": "OPENROUTER_API_KEY",
        "baseUrl": "https://openrouter.ai/api/v1"
      },
      "deepseek": {
        "provider": "deepseek",
        "keyEnv": "DEEPSEEK_API_KEY",
        "baseUrl": "https://api.deepseek.com"
      },
      "groq": {
        "provider": "groq",
        "keyEnv": "GROQ_API_KEY",
        "baseUrl": "https://api.groq.com/openai/v1"
      },
      "google-gemini": {
        "provider": "google-gemini",
        "keyEnv": "GEMINI_API_KEY",
        "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai/"
      }
    },
    "scenarios": {
      "default": {
        "primary": "claude-code,claude-sonnet-4-5",
        "fallbacks": [
          "openrouter,anthropic/claude-sonnet-4.6",
          "google-gemini,gemini-2.5-flash"
        ]
      },
      "background": {
        "primary": "groq,llama-3.1-8b-instant",
        "fallbacks": [
          "deepseek,deepseek-v4-flash",
          "google-gemini,gemini-2.5-flash-lite"
        ]
      },
      "longContext": {
        "primary": "google-gemini,gemini-2.5-pro",
        "fallbacks": [
          "openrouter,google/gemini-2.5-pro",
          "openrouter,anthropic/claude-sonnet-4.6"
        ]
      },
      "reasoning": {
        "primary": "deepseek,deepseek-v4-pro",
        "fallbacks": [
          "openrouter,anthropic/claude-sonnet-4.6",
          "codex,gpt-5.5"
        ]
      },
      "webSearch": {
        "primary": "openrouter,anthropic/claude-sonnet-4.6",
        "fallbacks": [
          "google-gemini,gemini-2.5-flash",
          "groq,groq/compound"
        ],
        "requestOverrides": {
          "openrouter": { "plugins": [{ "id": "web" }] },
          "google-gemini": {
            "extra_body": { "google": { "google_search": {} } }
          }
        }
      }
    }
  }
}
```

### Copy-paste provider blocks

**OpenRouter**

```json
{
  "provider": "openrouter",
  "keyEnv": "OPENROUTER_API_KEY",
  "baseUrl": "https://openrouter.ai/api/v1",
  "defaultModel": "anthropic/claude-sonnet-4.6"
}
```

**DeepSeek**

```json
{
  "provider": "deepseek",
  "keyEnv": "DEEPSEEK_API_KEY",
  "baseUrl": "https://api.deepseek.com",
  "defaultModel": "deepseek-v4-pro"
}
```

**Groq**

```json
{
  "provider": "groq",
  "keyEnv": "GROQ_API_KEY",
  "baseUrl": "https://api.groq.com/openai/v1",
  "defaultModel": "openai/gpt-oss-120b"
}
```

**Google Gemini**

```json
{
  "provider": "google-gemini",
  "keyEnv": "GEMINI_API_KEY",
  "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai/",
  "defaultModel": "gemini-2.5-flash"
}
```

### Factory wiring (implementation hint)

Each new kind constructs `new OpenAiBackend({ baseUrl, apiKey: process.env[spec.keyEnv], defaultModel })` — no new `Backend` interface methods. Providers that need `extra_body` / `plugins` require the router to merge `requestOverrides` into the outbound JSON body before `backend.chat()`.

### Env var summary

| Provider kind | Default `keyEnv` | Notes |
| --- | --- | --- |
| `openrouter` | `OPENROUTER_API_KEY` | New |
| `deepseek` | `DEEPSEEK_API_KEY` | New |
| `groq` | `GROQ_API_KEY` | New |
| `google-gemini` | `GEMINI_API_KEY` | Same as panel `google` |
| `openai` | `OPENAI_API_KEY` | Existing |
| `anthropic` | `ANTHROPIC_API_KEY` | Existing |

Load order unchanged: `loadEnvFileInto` from `.env` at cwd and repo root (`packages/cli/src/fusion/env.ts`) before resolving keys.

### Validation rules (proposed for `fusion-config.ts`)

- `routing.providers` values must satisfy `RoutingProviderSpec`.
- `routing.scenarios.*.primary` must be `auth,model` or `providerKind,modelId`.
- `providerKind` must exist in `routing.providers` **unless** it is `claude-code` or `codex`.
- `baseUrl` overrides must be HTTPS in production (allow `http://127.0.0.1` for tests).
- Unknown scenario keys should warn but not fail parse — forward compatibility.

### Migration / compatibility

- Repos without `routing` block continue using panel defaults from `DEFAULT_CLOUD_PANEL` (`packages/cli/src/fusion/env.ts`).
- `google` panel provider and `google-gemini` routing kind coexist; a future Phase may alias them.
- Do **not** add the four new kinds to `PANEL_PROVIDERS` until FusionKit Python `serve-endpoint` can spawn them — routing layer only in Phase 2.

---

## 5. Translation Risk Audit

### OpenRouter

| Risk area | Detail | `anthropic.ts` chain verdict |
| --- | --- | --- |
| Ignored OpenAI fields | Upstream may ignore `top_k`, `logit_bias` on non-OpenAI models ([Overview](https://openrouter.ai/docs/api-reference/overview)) | **Just Works** — ignored fields harmless |
| `tool` messages | OpenAI `role:"tool"` + `tool_call_id` | **Just Works** — standard path |
| Anthropic `tool_use` / `tool_result` | Mapped in `anthropicToChat` | **Just Works** via existing adapter |
| Image blocks | Mapped to `image_url` | **Just Works** if upstream model supports vision |
| Extended thinking | `reasoning` / `reasoning_effort` OR-only fields | **Needs tweak** — thinking not mapped to Anthropic thinking blocks; appears as plain text or dropped |
| Streaming tool_calls | Standard OpenAI delta | **Just Works** for most models; per-model variance — monitor |
| Web search annotations | `annotations[].url_citation` on message | **Needs tweak** — `chatToAnthropicMessage` does not map citations to Anthropic content blocks |

### DeepSeek

| Risk area | Detail | `anthropic.ts` chain verdict |
| --- | --- | --- |
| `reasoning_content` | Required on tool multi-turn ([Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)) | **Needs per-provider tweak** — not in OpenAI types; must preserve on assistant messages |
| `thinking` / `extra_body` | Not in Anthropic request | **Needs tweak** — enable/disable thinking per scenario |
| Tool calls | OpenAI shape documented | **Just Works** only if thinking disabled OR `reasoning_content` passthrough implemented |
| `temperature` etc. | Ignored in thinking mode | **Just Works** — no error, but may surprise users |
| Context 1M | `max_tokens` sizing | **Needs runtime verification** — large `max_tokens` + 1M input may hit proxy timeouts |
| Anthropic thinking blocks | No native equivalent in DeepSeek | **Lossy** — Claude Code extended thinking UI won't reflect DeepSeek CoT |

### Groq

| Risk area | Detail | `anthropic.ts` chain verdict |
| --- | --- | --- |
| `logprobs`, `logit_bias`, `messages[].name` | **400 if present** ([OpenAI Compatibility](https://console.groq.com/docs/openai)) | **Needs tweak** — strip forbidden fields on Groq routes |
| `n` > 1 | **400** | **Just Works** — gateway never sets `n` |
| `temperature: 0` | Coerced to 1e-8 | **Just Works** — minor behavioral drift |
| Parallel tool_calls | Model-dependent | **Just Works** on supported models; may need `parallel_tool_calls: false` for oss models |
| `groq/compound` | Server-side tools only | **Needs separate scenario path** — client `tools[]` from Claude Code won't map |
| 128K context | Below Claude's possible 200K+ sessions | **Context overflow** — detect via 413/400 and fallback |

### Google Gemini

| Risk area | Detail | `anthropic.ts` chain verdict |
| --- | --- | --- |
| OpenAI compat **beta** | Gaps likely ([OpenAI compatibility — limitations](https://ai.google.dev/gemini-api/docs/openai)) | **Needs runtime verification** on every scenario |
| `extra_body` / grounding | Required for `webSearch` | **Needs per-provider tweak** — not in stock OpenAI body |
| `reasoning_effort` vs thinking | Mutual exclusion with `thinking_config` | **Needs tweak** — scenario must pick correct knob |
| Tool call `id` (Gemini 3+) | Must round-trip in function responses ([Function calling](https://ai.google.dev/gemini-api/docs/function-calling)) | **Needs runtime verification** through OpenAI compat |
| System message | Supported in compat examples | **Just Works** |
| Image blocks | `image_url` supported | **Likely works** — verify multimodal + tools together |
| Anthropic thinking | Gemini thinking tokens in response | **Lossy** — not mapped to Anthropic thinking deltas today |

### Cross-cutting Anthropic → OpenAI → provider risks

The `anthropic.ts` adapter (`anthropicToChat` / `chatToAnthropicMessage` / `openAiSseToAnthropic`) was built for local MLX and single-cloud OpenAI backends. These Anthropic features have **no standard OpenAI equivalent** and behavior on third-party providers is undefined:

| Anthropic feature | Current adapter behavior | Risk on Phase 2 providers |
| --- | --- | --- |
| `tool_choice.type: "any"` | Maps to OpenAI `tool_choice: "required"` | Usually works; Groq/Gemini **needs runtime verification** |
| `tool_choice.type: "tool"` | Maps to `{type:"function", function:{name}}` | Works when name matches |
| `tool_result.is_error` | Appended as text in tool message | Error semantics lost |
| Image blocks | `image_url` data URLs | Gemini/OpenRouter vision models OK; Groq text-only models fail |
| `stop_sequences` | OpenAI `stop` | Generally forwarded |
| `max_tokens` | OpenAI `max_tokens` | DeepSeek max output 384K — clamp may be needed |
| Streaming `tool_use` blocks | Via OpenAI `delta.tool_calls` | Highest-risk path; test all four providers |
| Extended thinking (Anthropic) | Not in OpenAI spec | Not forwarded to any Phase 2 provider |

**Recommended Phase 2 test matrix (minimum):**

1. Single-turn text completion (non-streaming)
2. Single-turn text completion (streaming)
3. Single tool call round-trip (non-streaming)
4. Single tool call round-trip (streaming)
5. Multi-turn tool loop (3+ tools)
6. Image + text user message (Gemini + OpenRouter only)
7. `longContext` — 50K+ token synthetic prompt on Gemini 2.5 Pro
8. `reasoning` — DeepSeek v4-pro with thinking enabled
9. `webSearch` — OpenRouter `plugins:[web]` and Gemini grounding

---

## 6. Fallback Chain Design

### Triggers (recommended)

| Condition | HTTP / signal | Action |
| --- | --- | --- |
| Rate limit | **429** | Fallback to next provider in scenario list; honor `retry-after` if present (Groq documents this — [Rate Limits](https://console.groq.com/docs/rate-limits)) |
| Insufficient credits | **402** (DeepSeek, OpenRouter) | Fallback immediately — user-action required on that provider |
| Auth failure | **401**, **403** | Fallback; surface notice if all providers fail auth |
| Server / gateway errors | **500**, **502**, **503**, **504** | Retry once with backoff on same provider, then fallback |
| Groq flex capacity | **498** | Fallback immediately ([Errors](https://console.groq.com/docs/errors)) |
| Context / payload errors | **413**, **422** with context hints | Skip to `longContext` scenario target or next fallback |
| Network / timeout | `fetch` failure, abort | Retry with exponential backoff (1×, 2×), then fallback |
| DeepSeek overload | **503** ([Error codes](https://api-docs.deepseek.com/quick_start/error_codes)) | Backoff + fallback |

**Do not fallback** on **400** (client/schema bugs) except Groq-specific field stripping retry. **Do not fallback** on **404** model-not-found — fix config.

### Error uniformity

| Provider | Uniform JSON error? | Notes |
| --- | --- | --- |
| OpenRouter | **Mostly yes** | Normalized `error: { code, message, metadata }` on choices; HTTP status mirrors class ([Overview — ErrorResponse](https://openrouter.ai/docs/api-reference/overview)) |
| DeepSeek | **Partial** | HTTP status + message table ([Error codes](https://api-docs.deepseek.com/quick_start/error_codes)); body shape OpenAI-like |
| Groq | **Yes** | `error.message` + `error.type` ([Errors](https://console.groq.com/docs/errors)) |
| Google Gemini | **Partial** | OpenAI compat errors expected; **needs runtime verification** for exact JSON |

**Recommendation:** implement a shared `classifyProviderError(status, body)` returning `retry | fallback | fatal`. Start with HTTP status codes; parse `error.message` for context-length keywords as secondary heuristic (`context length`, `maximum`, `too many tokens`).

### Retry / backoff

| Provider | Recommendation |
| --- | --- |
| OpenRouter | Rely on existing gateway retry for 5xx; **no** aggressive retry on 429 (OR has its own provider routing) |
| DeepSeek | Respect keep-alive / long inference ([Rate Limit — Keep-Alive](https://api-docs.deepseek.com/quick_start/rate_limit)); 503 → 2s exponential backoff, max 2 attempts |
| Groq | Honor `retry-after` header; 429 → fallback preferred over retry (low TPM ceilings) |
| Google Gemini | 429/503 → backoff 1s/2s; **needs runtime verification** |

OpenRouter's own `route: "fallback"` and `models: [...]` handle **intra-OpenRouter** model fallback ([Provider Selection](https://openrouter.ai/docs/guides/routing/provider-selection)) — distinct from FusionKit's **cross-provider** scenario fallbacks. Do not conflate the two layers.

### Pseudocode: scenario fallback loop

```
function routeChat(scenario, anthropicBody):
  targets = [scenario.primary, ...scenario.fallbacks]
  overrides = scenario.requestOverrides ?? {}

  for target in targets:
    if target is subscription and not detectSubscription(target.auth).available:
      continue
    provider = resolveProvider(target.providerKind)
    if not provider.apiKey: continue

  body = anthropicToChat(anthropicBody, target.model)
  merge(overrides[target.providerKind], body)

    response = provider.backend.chat(body)
    if response.ok: return adapt(response)

    action = classifyProviderError(response.status, await response.json())
    if action == "retry":
      response = retryWithBackoff(provider.backend.chat, body)
      if response.ok: return adapt(response)
    if action == "fallback": continue
    if action == "fatal": return response

  return 503 all_providers_exhausted
```

### Observability hooks

Reuse `BackendRequestOptions.modelCallId` (`x-velum-model-call-id` header in `backend.ts`) to tag traces with `{scenario, providerKind, modelId, attempt}`. When `--observe` is enabled, fallback events should emit structured log lines so the scope dashboard can show which provider served each Claude Code turn.

---

## 7. Open Questions

- **`claude-router-implementation-report.md` missing on `main`** — referenced in task background but not present in repo (also absent on `origin/feature/claude-code-router`). Confirm scenario keys and `RoutingProviderSpec` final shape against that branch before implementation merges.
- **DeepSeek `reasoning_content` through `anthropic.ts`** — Does ignoring it break Claude Code tool loops in practice? Needs end-to-end test with `deepseek-v4-pro` thinking + tools enabled.
- **DeepSeek base URL** — Confirm `https://api.deepseek.com` vs `https://api.deepseek.com/v1` against live API (docs curl uses former; some SDK examples use `/v1`).
- **OpenRouter model catalog vs DeepSeek direct** — OpenRouter still lists `deepseek/deepseek-chat` (131K ctx) but direct API documents `deepseek-v4-*` (1M). Which ids should `deepseek,*` scenario targets use when routing via OpenRouter vs direct?
- **Groq streaming `tool_calls`** — Docs show non-streaming shape; streaming delta `index` behavior for parallel tools **needs runtime verification**.
- **Gemini OpenAI compat tool streaming** — Beta doc covers non-streaming function calling; streaming tool deltas **needs runtime verification**.
- **Gemini rate limits** — Official rate-limits page did not load during research; pull RPM/TPM from AI Studio console or retry fetch.
- **Gemini `google_search` via OpenAI compat** — Exact `extra_body` shape for `webSearch` scenario **needs runtime verification** (native docs use `tools: [{google_search: {}}]` on GenerateContent, not Chat Completions).
- **OpenRouter SSE comment lines** — Confirm `anthropic.ts` SSE parser (`openAiSseToAnthropic`) ignores `:` comments or add filter.
- **Context-length error detection** — None of the providers document a stable machine-readable "context_window_exceeded" code; keyword parsing may be required.
- **Subscription detection for scenario defaults** — Should router auto-skip `claude-code`/`codex` targets when `detectSubscription()` reports unavailable (`packages/cli/src/fusion/subscriptions.ts`)? Not specified in panel config today.
- **Groq `groq/compound` billing** — Models page shows "-" for compound pricing; cost model for `webSearch` fallback **unclear**.

---

## 8. Implementation Order Recommendation

1. **Groq** — Most OpenAI-compatible of the four with explicit unsupported-field list (easy to strip). Fastest feedback loop for `anthropic.ts` adapter validation. Low context window surfaces overflow fallback early. Start with `llama-3.3-70b-versatile` (tools + parallel), then `llama-3.1-8b-instant` for `background`.

2. **OpenRouter** — Second: pure OpenAI shape, one `OpenAiBackend` covers hundreds of models; validates cross-provider fallback plumbing and `provider,model` id parsing (`anthropic/claude-sonnet-4.6`). Enables OR-based fallbacks before direct keys exist. Add `plugins` / `webSearch` overrides after basic routing works.

3. **DeepSeek** — Third: still OpenAI-shaped but **thinking + `reasoning_content`** create real multi-turn tool risk. Implement with thinking **disabled** first (`extra_body.thinking.type: disabled` on v4-flash), then add reasoning passthrough as a follow-up within Phase 2 if tests pass.

4. **Google Gemini** — Last: OpenAI compat explicitly **beta**; requires `extra_body` for grounding/thinking; tiered pricing above 200K tokens complicates `longContext` cost estimation; most translation work for `webSearch` and thinking knobs.

**Parallel track:** extend `fusion-config.ts` validation + `PANEL_PROVIDERS` only after `RoutingProviderKind` is stable — panel providers and routing providers serve different layers (see `packages/cli/src/shared/options.ts`).

### Per-provider exit criteria (Definition of Done for Phase 2 implementation)

| Provider | Ship when |
| --- | --- |
| Groq | Tests 1–5 pass on `llama-3.3-70b-versatile`; forbidden fields stripped; 429 triggers fallback |
| OpenRouter | Tests 1–6 pass on `anthropic/claude-sonnet-4.6`; `plugins.web` works for `webSearch`; model ids with `/` parse correctly |
| DeepSeek | Tests 1–5 pass on `deepseek-v4-flash` (thinking off); document thinking-on tool loop status |
| Google Gemini | Tests 1–7 pass on `gemini-2.5-flash`; `longContext` on `gemini-2.5-pro`; `extra_body` grounding prototype for `webSearch` |

---

## Appendix A — Model ID quick reference (2026-06-22)

Direct API model strings (use after `provider,` in scenario tuples):

| Provider | Example model ids |
| --- | --- |
| OpenRouter | `anthropic/claude-sonnet-4.6`, `google/gemini-2.5-pro`, `openai/gpt-5.2`, `deepseek/deepseek-v3.2` |
| DeepSeek | `deepseek-v4-pro`, `deepseek-v4-flash` |
| Groq | `openai/gpt-oss-120b`, `llama-3.3-70b-versatile`, `llama-3.1-8b-instant`, `groq/compound` |
| Google Gemini | `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-3.5-flash` |

Subscription targets (no provider block in `routing.providers`):

| Auth mode | Example model ids |
| --- | --- |
| `claude-code` | `claude-sonnet-4-5` (default in `subscriptions.ts`), `claude-sonnet-4-6` |
| `codex` | `gpt-5.5` (default in `subscriptions.ts`) |

---

## Appendix B — Files the implementing agent will touch (not in this PR)

| File | Expected change |
| --- | --- |
| `packages/model-gateway/src/routing/providers.ts` | `RoutingProviderSpec`, provider registry |
| `packages/model-gateway/src/routing/router.ts` | Scenario selection + fallback loop |
| `packages/cli/src/fusion/routing.ts` | CLI → router config bridge |
| `packages/cli/src/fusion-config.ts` | Parse/validate `routing` block |
| `packages/model-gateway/src/backend.ts` | Possible `extra_body` / header extensions |
| `packages/model-gateway/src/adapters/anthropic.ts` | Provider-specific outbound sanitizers |

**Out of scope per task:** do not modify the above in the research PR; this doc is the input to that work.

---

## 9. Sources

### OpenRouter

- https://openrouter.ai/
- https://openrouter.ai/docs/api-reference/overview
- https://openrouter.ai/docs/api-reference/chat-completion
- https://openrouter.ai/docs/guides/features/tool-calling
- https://openrouter.ai/docs/guides/features/web-search
- https://openrouter.ai/docs/guides/features/plugins
- https://openrouter.ai/docs/guides/routing/provider-selection
- https://openrouter.ai/api/v1/models (live catalog, fetched 2026-06-22)

### DeepSeek

- https://api-docs.deepseek.com/
- https://api-docs.deepseek.com/quick_start/pricing
- https://api-docs.deepseek.com/quick_start/rate_limit
- https://api-docs.deepseek.com/quick_start/error_codes
- https://api-docs.deepseek.com/guides/function_calling
- https://api-docs.deepseek.com/guides/thinking_mode

### Groq

- https://groq.com/
- https://console.groq.com/docs/openai
- https://console.groq.com/docs/tool-use
- https://console.groq.com/docs/models
- https://console.groq.com/docs/rate-limits
- https://console.groq.com/docs/errors

### Google Gemini

- https://ai.google.dev/gemini-api/docs/openai
- https://ai.google.dev/gemini-api/docs/models
- https://ai.google.dev/gemini-api/docs/pricing
- https://ai.google.dev/gemini-api/docs/function-calling
- https://ai.google.dev/gemini-api/docs/google-search

### FusionKit (repo)

- `packages/model-gateway/src/backend.ts` — `OpenAiBackend`, `Backend` interface
- `packages/model-gateway/src/adapters/anthropic.ts` — Anthropic ↔ OpenAI translation, `claudeModelAlias`
- `packages/cli/src/fusion/env.ts` — `PanelProvider`, `PanelAuthMode`, `defaultKeyEnv`
- `packages/cli/src/fusion/subscriptions.ts` — Claude Code / Codex subscription detection
- `packages/cli/src/shared/options.ts` — `PANEL_PROVIDERS`, `parsePanelModelSpec`
- `packages/cli/src/fusion-config.ts` — `.fusionkit/fusion.json` schema
