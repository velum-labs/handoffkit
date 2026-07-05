# Local-model harness bridge spec

Date: 2026-06-13
Status: Draft
Related: [Governed agent execution plane spec](../legacy/specs/2026-06-11-governed-agent-execution-plane-spec.md)

Design note: this document specifies a new capability — making a locally
running model transparently back the major vendor agent harnesses (Claude
Code, Codex, opencode, and Cursor in plan mode) — without changing how people
already use those tools. It builds on the existing local-serving and routing
core (`mlxServer`/`ManagedModelServer`, `routedModel`/uniroute, the owned
`velum-labs/mlx-lm` fork) and is delivered as a new package,
`@fusionkit/model-gateway`, plus a `warrant local` CLI surface.

## 1. Goal

Make a locally running model — the owned `mlx_lm.server` fork, a
`routedModel`/uniroute selection, or any OpenAI-compatible local server
(Ollama, vLLM, LM Studio) — transparently power:

- **Claude Code**
- **Codex**
- **opencode**
- **Cursor** (plan/chat panel only; see §7)

with zero change to the user's existing workflow: they keep running `claude`,
`codex`, `opencode` (and Cursor) exactly as before; only the backing model
changes to a local one.

Non-negotiables (decided):

- **Build native.** No LiteLLM / Bifrost / external gateway dependency. The
  translation layer is ours, in keeping with the repo's trusted-pin,
  auditable posture.
- **Transparent launcher UX.** A `warrant local <tool> …` command ensures the
  model and gateway are up, applies the per-tool shim, then `exec`s the real
  binary with the user's original arguments.
- **Full effort**, sequenced opencode → Claude Code → Codex → Cursor.

## 2. The core constraint: the wire-protocol matrix

Each harness accepts a custom model endpoint only in its own dialect. We own
an OpenAI Chat Completions server (the `velum-labs/mlx-lm` fork), so the work
is the *translation* each harness requires.

| Harness | How it targets a custom endpoint (no UX change) | Dialect required | Translation we build |
| --- | --- | --- | --- |
| opencode | custom provider / `-m provider/model` | OpenAI **Chat Completions** | none (passthrough) |
| Claude Code | `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` | **Anthropic Messages** (`/v1/messages`, `/v1/messages/count_tokens`) | Anthropic ⇄ chat |
| Codex | `~/.codex/config.toml` `[model_providers.x]` `base_url` | OpenAI **Responses** only (`/v1/responses`; `wire_api="chat"` removed) | Responses ⇄ chat |
| Cursor (plan mode) | IDE "Override OpenAI Base URL" (plan/chat only; localhost blocked) | OpenAI **Chat Completions** + public URL | none (passthrough) + tunnel |

### 2.1 Verified facts behind the matrix

- **Claude Code** speaks Anthropic Messages to whatever `ANTHROPIC_BASE_URL`
  points at; native providers are Anthropic/Bedrock/Vertex; `/v1/models`
  discovery applies "only to the Anthropic Messages format"
  (`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`, v2.1.129+). The entire
  proxy ecosystem (LiteLLM Anthropic endpoint, Bifrost, claude-code-proxy,
  ccproxy) exists because Claude Code does not consume OpenAI-compatible
  endpoints natively. A third-party claim of a `settings.json`
  `"apiProvider": "openai-compatible"` is **unverified**: Claude Code ships as
  a ~500 MB compiled native binary (v2.1.177; the npm package is only a
  platform-detecting installer), so this must be settled with a live run.
  The Anthropic-Messages design is safe regardless.
- **Codex** is Responses-only: `wire_api="responses"` is the only supported
  value and the default; `wire_api="chat"` is removed and makes Codex refuse
  to start. A custom provider therefore needs a real `/v1/responses` endpoint.
- **The owned fork** (`velum-labs/mlx-lm`, pinned in
  `packages/adapter-ai-sdk/src/mlx-env.ts` as `MLX_LM_STRUCTURED_PIN`) serves
  `/v1/chat/completions`, `/v1/completions`, `/v1/models`, `/health`. It does
  **not** serve `/v1/embeddings`, `/v1/responses`, or `/v1/messages`.
- **Cursor** routes inference through its proprietary Connect-RPC/protobuf
  backend (`aiserver.v1.ChatService/StreamUnifiedChatWithTools`, version-gated
  headers). `cursor-agent`'s `--endpoint` points at a *Cursor* API endpoint
  (default `https://api2.cursor.sh`), not an OpenAI base URL, and the CLI
  config (`cli-config.json`) has no custom-model-provider field. Even
  self-hosted pools move only *tool execution* local, never inference. The
  only sanctioned custom-model path is the **IDE's** "Override OpenAI Base
  URL", which works for the **plan/chat panel only** (Composer, inline edit,
  apply, autocomplete stay on Cursor's cloud) and cannot reach `localhost`.

## 3. Architecture

One native TypeScript gateway fronts any local backend and exposes every
needed dialect; thin launchers wire each tool to it.

```
 claude   ─Anthropic /v1/messages──▶┐
 codex    ─Responses /v1/responses─▶┤  @fusionkit/model-gateway (native TS)        backend (LanguageModelV3)
 opencode ─OpenAI /v1/chat─────────▶┤   • dialect adapters ⇄ chat-completions  ┌─ mlxServer (velum-labs fork, owned)
 cursor   ─OpenAI /v1/chat (tunnel)─┤   • routedModel / uniroute selection  ───┼─ routedModel / uniroute
                                    │   • provenance hooks (model.called/cost) └─ any OpenAI-compatible (Ollama/vLLM)
                                    └── /v1/models  /v1/embeddings
                                                  ▲
                                       managed tunnel (Cursor only)
```

Why a gateway and not only the fork:

- **Backend-agnostic** — also fronts Ollama/vLLM/LM Studio, covering
  non-Apple-Silicon hosts where `mlxServer` cannot run.
- **Fits the Node posture** — built on Node built-ins where practical; lives
  in the TS monorepo; reuses `ManagedModelServer` lifecycle and `routedModel`.
- **Provenance home** — the single choke point through which every harness's
  model traffic flows, so `model.called`/usage/tool events can be recorded.

The owned fork is still extended where server-side is strictly better —
notably adding `/v1/embeddings` and hardening tool-call/structured-output
emission that the Anthropic/Responses adapters depend on.

## 4. Components

New package `@fusionkit/model-gateway`:

- `server.ts` — HTTP server (Node `node:http`), route table, bearer-token auth
  (deny-by-default), lifecycle reusing `ManagedModelServer` (lazy start,
  `/v1/models` health, idle scale-to-zero).
- `backend.ts` — accepts a `LanguageModelV3` (`mlxServer(...)`,
  `routedModel(...)`) or a plain OpenAI-compatible base URL; normalizes to a
  single internal "core" (chat-completions shape).
- `adapters/chat.ts` — `/v1/chat/completions`, `/v1/models`, `/v1/embeddings`
  (passthrough / proxy to the backend).
- `adapters/anthropic.ts` — `/v1/messages`, `/v1/messages/count_tokens`,
  Anthropic `/v1/models` discovery; full request/response/SSE translation
  (system, `tool_use`/`tool_result`, `anthropic-version`/`anthropic-beta`).
- `adapters/responses.ts` — `/v1/responses` (non-stream + stream); translation
  of reasoning items, `output_text`, function tools, `item.*`/`turn.*` events.
- `provenance.ts` — event-hook interface emitting `model.called`, token/cost,
  and tool events, reusing the `RunEvent` vocabulary in `@fusionkit/protocol`.
- `tunnel.ts` — pluggable tunnel adapter (Cursor only).

Touched:

- `packages/cli/src/index.ts` — new `warrant local` command group.
- `velum-labs/mlx-lm` (owned fork) — add `/v1/embeddings`; tool-call/structured
  hardening; bump `MLX_LM_STRUCTURED_PIN` after review.
- Reuse the transcript normalization patterns in
  `legacy/packages/session-harness/src/transcript.ts` for uniform evidence when
  provenance is enabled.

## 5. Per-harness integration

### 5.1 opencode (first; essentially free)

- Gateway: `/v1/chat/completions` + `/v1/models` passthrough.
- Launcher `warrant local opencode …`: ensure gateway+model up; register a
  custom OpenAI provider at `http://127.0.0.1:<port>/v1` (or pass
  `-m provider/model`); `exec opencode "$@"`.
- Validates the whole spine (lifecycle, backend, chat surface) with no
  translation.

### 5.2 Claude Code (Anthropic adapter)

- Gateway: `/v1/messages` (+ `count_tokens`, + discovery `/v1/models` returning
  `claude`/`anthropic`-prefixed ids so the local model appears in `/model`).
- Launcher `warrant local claude …`: set `ANTHROPIC_BASE_URL`,
  `ANTHROPIC_AUTH_TOKEN`; `exec claude "$@"`.
- Hardest correctness: SSE event mapping and tool-call round-trips.

### 5.3 Codex (Responses adapter)

- Gateway: `/v1/responses` (non-stream + stream).
- Launcher `warrant local codex …`: write an ephemeral Codex config (own
  `CODEX_HOME` or `--profile`) with `[model_providers.warrant-local]`
  (`base_url`, `wire_api="responses"`, `requires_openai_auth=false`) and a
  profile selecting it; `exec codex "$@"`.
- Highest-effort adapter (Responses semantics).

### 5.4 Cursor — plan-mode via managed tunnel (option B)

- Gateway: reuse the chat surface; must be reachable over a public URL
  (Cursor blocks `localhost`).
- `tunnel.ts`: pluggable tunnel provider (cloudflared/ngrok/bore), preserving
  host headers; ephemeral, authenticated, deny-by-default.
- `warrant local cursor`: start gateway + tunnel; configure Cursor IDE Models
  settings (Override OpenAI Base URL = tunnel `…/v1`, custom model name, dummy
  key) — auto-write where a writable settings location exists, else print
  exact values and verify connectivity.
- Documented limits: plan/chat panel only; Composer/inline/apply/autocomplete
  stay on Cursor's cloud; tunnel required. No reverse-engineered backend
  emulation.

## 6. Transparent launcher UX

`warrant local <tool> [args…]`:

1. Resolve/start the local backend (mlx fork via `mlxServer`, configured
   OpenAI-compatible URL, or `routedModel`).
2. Ensure the gateway is running (start if needed; health-check).
3. Apply the tool-specific shim (env / config file / IDE settings / tunnel).
4. `exec` the real binary with the user's original args — identical UX, local
   brain.

Plus `warrant local serve` (run the gateway standalone) and
`warrant local status`.

## 7. Provenance integration

Design the `provenance.ts` hook from day one, but ship v1 with it opt-in
behind a flag (pure connectivity by default). Fast-follow: emit
`model.called`/usage/tool events into the receipt machinery so "a local model
backed Claude Code — here is the signed proof of every call" becomes a natural
capability, re-converging with the platform thesis without blocking the
connectivity milestones.

## 8. Testing strategy

- **Golden fixtures**: capture real request/response/stream payloads from each
  CLI (Claude Code Anthropic, Codex Responses, opencode chat, Cursor chat) and
  assert translator round-trips.
- **Stream conformance**: byte-level SSE/event-ordering tests for the Anthropic
  and Responses adapters.
- **Mock-backend integration**: each launcher end-to-end against a mock model
  (CI-safe, no keys), matching the repo's mock-first demo convention.
- **Fidelity tests**: tool-calling and structured-output adherence against a
  small local model.
- **Empirical verification matrix** (live, requires the sandbox shell):
  1. Claude Code: point `ANTHROPIC_BASE_URL` at a logging stub; confirm it
     calls `/v1/messages` and capture the exact payload; settle whether any
     `apiProvider: openai-compatible` path exists.
  2. Codex: confirm `/v1/responses` request/stream shape via a stub provider.
  3. opencode: custom provider → mlx fork end-to-end.
  4. Cursor: confirm plan-mode reaches the tunnel; find where the IDE persists
     the base-URL override for automation.

## 9. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Responses adapter complexity (Codex chat removed) | Highest test budget; golden stream fixtures; isolate in `adapters/responses.ts`. |
| Local-model tool-call/structured fidelity | Fix at source in the owned fork (structured FSM exists); capability-gate features per model. |
| Claude Code openai-compatible claim unverified | Design to Anthropic Messages (guaranteed safe); live-binary test to confirm/expand. |
| Cursor plan-mode-only + tunnel + config automation | Documented limits; ephemeral authenticated tunnel; auto-config where possible, else guided + verified. |
| mlx is Apple-Silicon-only | Gateway is backend-agnostic; Ollama/vLLM/LM Studio work as backends elsewhere. |
| Tunnel exposes local model publicly | Bearer auth on gateway, deny-by-default, ephemeral tunnel, scoped to chat surface. |

## 10. Milestones

- M0 — Empirical verification matrix + `@fusionkit/model-gateway` skeleton
  (lifecycle, auth, backend binding).
- M1 — opencode: chat passthrough + launcher, end-to-end on the mlx fork.
- M2 — Claude Code: Anthropic adapter + launcher + discovery.
- M3 — Codex: Responses adapter + launcher.
- M4 — Cursor (B): tunnel + IDE config command, documented limits.
- M5 — `/v1/embeddings` fork extension, `routedModel`/uniroute backend wiring,
  provenance hooks, README + spec updates.
