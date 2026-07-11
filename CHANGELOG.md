# Changelog

Release notes for the FusionKit monorepo: `@fusionkit/*` npm packages, the `@velum-labs/model-fusion-protocol` contract package, and the PyPI `fusionkit` package set. Release tags are named `handoffkit-v*` for historical reasons.

## Unreleased

- Fixed `fusionkit codex` replacing Codex's model picker with only fusion/panel models (Codex applies `model_catalog_json` as a full replacement): the gateway now acts as a live relay to the Codex backend — with a `codex login`, the session reuses it, `GET /v1/models` merges the fusion/panel entries in front of Codex's live stock catalog, and picking a stock model forwards the request verbatim to the Codex backend under the user's own auth (same billing, never silently fused). Without a login, a generated static catalog still lists the fusion/panel entries.
- Added `fusionkit install codex` / `fusionkit uninstall codex`: additive registration of FusionKit into the user's real `~/.codex/config.toml` (a managed marker block with a `fusionkit` provider + one launch profile per ensemble), so `codex --profile fusion-panel` runs fused sessions against `fusionkit serve` while plain `codex` stays untouched — and the gateway relay keeps the full model picker inside those sessions too.
- Unified the fusionkit engine repository into this monorepo, completed the Warrant → FusionKit rename, and severed the legacy Warrant stack from the active workspace (OSS release prep: legacy isolation, deep clean, community files).
- Cut the runtime over to the FusionKit kernel with a native front door, and added the `@fusionkit/harness-core` driver architecture with official-SDK drivers and process-safety fixes.
- Added gateway-executed web search with server-tool parity for Codex and Claude Code: the gateway projects the caller's `web_search` / `web_search_20250305` tool to the fused panel, executes calls by delegating to the dialect's own provider (cross-provider fallback with one key), and renders native `web_search_call` / `server_tool_use` + `web_search_tool_result` items in buffered and streaming responses. Configured via `FUSIONKIT_WEB_SEARCH*` env vars, reported by `fusionkit doctor`, documented in `docs/configuration.md`.
- Overhauled the CLI experience: interactive palette, fuzzy pickers, init wizard, error panels, and dynamic completion; a serve cockpit with a timestamped request log, gateway panel, and Ctrl+C receipt across long-running surfaces; an exit-code epilogue with honest first-run failures; and styled output on the remaining raw surfaces.
- Added a Cursor BYOK endpoint (`/v1/cursor`) translating Cursor's Responses-hybrid requests, `--expose` for a public HTTPS tunnel, and `--k` step boundaries for panel members.
- Added the OpenRouter provider and routed Claude Code non-Anthropic panel members via translation gateways; added panel trust levels, context packing for judging, pricing/local-compute configuration, provider cost handling, and a straggler grace window.
- Hardened the gateway wire behavior: honest dialect drops with closed field gaps and sampling propagation, one SSE codec and one chat assembler behind every streamed turn, and a real usage ledger with exact-match pricing.
- Hardened judge prompts and parsing (nonce fences, structured output, id-based decisions) and judge/panel robustness: clamped and jittered retries classified by status over prose, hostile-YAML model-id coverage, stale-router respawn, and panel-id uniqueness.
- Session integrity: per-session locking, turns compaction, awaited persistence, and random ids; supervised process groups with crash-safe cleanup everywhere.
- Security: allow-listed child environments, redacted OTLP exports, and timing-safe gateway auth.
- Replaced the hand-rolled fusion trace spine with OpenTelemetry end to end: native spans with W3C `traceparent`/`baggage` propagation, real OTel events (log records over OTLP/HTTP logs) for live point-in-time signals like trajectory steps and judge thinking, a new `@fusionkit/tracing` package, a semantic-conventions registry in `spec/fusion-trace/`, and standard `OTEL_*` configuration (PostHog/Jaeger/Tempo interop for free).
- Rewrote the scope dashboard as a native OTLP store (spans and events in SQLite, split OTLP/HTTP JSON ingest at `/api/ingest/v1/traces` and `/v1/logs`, live SSE) with a theming/DX overhaul, judge and cost views, production judge events, and deep links.
- Added strictly opt-in anonymous product telemetry (`fusionkit telemetry on|off|status|inspect`, PostHog, allow-listed fields, `DO_NOT_TRACK` honored) and documented the complete field list in `docs/privacy.md`.
- Fixed the Anthropic dialect forwarding legacy `max_tokens` (rejected by OpenAI reasoning models) — it now emits `max_completion_tokens` like the other adapters — and taught the fusion router to accept `max_completion_tokens` instead of silently dropping the caller's output cap.
- Fixed the Responses streaming egress crashing on the `"usage": null` chunks real OpenAI streams emit.
- Reworded the panel sandbox (`panelTrust`) prompts in `fusionkit init` and `fusionkit config edit`: the picker now explains what `full` and `guarded` actually allow (any command/file vs. each model's own draft worktree) instead of the jargony "panel candidate autonomy" copy, and shows an inline explainer with the recommended default.
- Release and repo plumbing: the release coordinator now promotes the Unreleased changelog section, runs preflights, and publishes the changelog to the docs site; opt-in run recording; protocol v0.6.0 preparation with schema-bundle-hash propagation; docs got per-tool pages, a unified tone, an intent-based sidebar taxonomy, and a comprehensive repository reference; dependency upgrades across the workspace (TypeScript 6, FastAPI 0.139, and friends).

## 0.8.0 - 2026-06-29

- Added failover, durable sessions, unified configuration, and turnkey Cursor IDE support for fused harness runs.
- Switched `@fusionkit/*` package publishing to npm OIDC trusted publishing with provenance.

## 0.7.4 - 2026-06-25

- Emitted per-candidate observability trace events from tool harnesses.

## 0.7.3 - 2026-06-24

- Reconstructed trajectories for Cursor-backed fusion panel runs.
- Removed unused candidate-summary diff artifact plumbing from the ensemble package.

## 0.7.2 - 2026-06-23

- Reconstructed trajectories from streamed SSE response bodies so streamed panel runs keep their evidence.

## 0.7.1 - 2026-06-23

- Preserved failed panel candidates in fusion results instead of silently dropping them.
- Corrected stale `trajectory:step` endpoint labels and comments to `trajectories:fuse`.

## 0.7.0 - 2026-06-23

- Adopted `@velum-labs/model-fusion-protocol` 0.5.0 with OpenAI Responses item support.
- Released the matching PyPI `fusionkit` 0.7.0 package set.

## 0.6.0 - 2026-06-23

- Adopted `@velum-labs/model-fusion-protocol` 0.4.0 and the matching PyPI `fusionkit` 0.6.0 package set.
- Pointed the gateway and ensemble packages at the unified fuse endpoint.

## 0.5.4 - 2026-06-22

- Release cut via the cross-repo coordinator (`scripts/release.mjs`).

## 0.5.3 - 2026-06-22

- Release cut via the cross-repo coordinator (`scripts/release.mjs`).

## 0.5.2 - 2026-06-22

- Release cut via the cross-repo coordinator (`scripts/release.mjs`).

## 0.5.1 - 2026-06-22

- Release cut via the cross-repo coordinator (`scripts/release.mjs`).

## 0.5.0 - 2026-06-22

- Release cut via the cross-repo coordinator (`scripts/release.mjs`).

## 0.4.1 - 2026-06-22

- Release cut via the cross-repo coordinator (`scripts/release.mjs`).

## 0.4.0 - 2026-06-22

- Release cut via the cross-repo coordinator (`scripts/release.mjs`).

## 0.3.0 - 2026-06-22

- Release cut via the cross-repo coordinator (`scripts/release.mjs`).

## 0.2.0 - 2026-06-22

- Release cut via the cross-repo coordinator (`scripts/release.mjs`).

## 0.1.8 - 2026-06-21

- Release cut via the cross-repo coordinator (`scripts/release.mjs`).

## 0.1.7 - 2026-06-21

- Release cut via the cross-repo coordinator (`scripts/release.mjs`).

Older entries are preserved as historical release-coordinator cuts. See `docs/releasing.md` for the plan/apply workflow.
