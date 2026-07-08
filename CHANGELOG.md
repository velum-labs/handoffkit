# Changelog

Release notes for the FusionKit monorepo: `@fusionkit/*` npm packages, the `@velum-labs/model-fusion-protocol` contract package, and the PyPI `fusionkit` package set. Release tags are named `handoffkit-v*` for historical reasons.

## Unreleased

- Fixed `fusionkit codex` replacing Codex's model picker with only fusion/panel models (Codex applies `model_catalog_json` as a full replacement): the gateway now acts as a live relay to the Codex backend — with a `codex login`, the session reuses it, `GET /v1/models` merges the fusion/panel entries in front of Codex's live stock catalog, and picking a stock model forwards the request verbatim to the Codex backend under the user's own auth (same billing, never silently fused). Without a login, a generated static catalog still lists the fusion/panel entries.
- Added `fusionkit install codex` / `fusionkit uninstall codex`: additive registration of FusionKit into the user's real `~/.codex/config.toml` (a managed marker block with a `fusionkit` provider + one launch profile per ensemble), so `codex --profile fusion-panel` runs fused sessions against `fusionkit serve` while plain `codex` stays untouched — and the gateway relay keeps the full model picker inside those sessions too.
- Reworded the panel sandbox (`panelTrust`) prompts in `fusionkit init` and `fusionkit config edit`: the picker now explains what `full` and `guarded` actually allow (any command/file vs. each model's own draft worktree) instead of the jargony "panel candidate autonomy" copy, and shows an inline explainer with the recommended default.
- Replaced the hand-rolled fusion trace spine with OpenTelemetry end to end: native spans with W3C `traceparent`/`baggage` propagation, a new `@fusionkit/tracing` package, a semantic-conventions registry in `spec/fusion-trace/`, and standard `OTEL_*` configuration (PostHog/Jaeger/Tempo interop for free).
- Rewrote the scope dashboard as a native OTLP span store (spans in SQLite, OTLP/HTTP JSON ingest, live SSE), replacing the custom `fusion-trace-event.v1` wire format, headers, and JSONL replay.
- Added strictly opt-in anonymous product telemetry (`fusionkit telemetry on|off|status|inspect`, PostHog, allow-listed fields, `DO_NOT_TRACK` honored) and documented the complete field list in `docs/privacy.md`.

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
