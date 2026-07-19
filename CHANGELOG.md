# Changelog

Release notes for the RouteKit/FusionKit monorepo: `@routekit/*` and
`@fusionkit/*` npm packages, the `@velum-labs/model-fusion-protocol` contract
package, and the PyPI FusionKit sidecar package set. Release tags are named
`handoffkit-v*` for historical reasons.

## Unreleased

- Split the neutral routing foundation into `@routekit/*` packages and the
  independent `routekit` CLI. RouteKit now owns explicit provider configuration,
  live namespaced model catalogs, credentials, multi-subscription account
  pooling, proxies, provider egress, and direct coding-tool launches.
- Added `routekit accounts login` for isolated, provider-supported Claude Code
  and Codex authentication that enrolls directly into RouteKit's native pool
  without replacing the user's normal official-CLI login.
- Simplified native model pickers: Claude Code presents `claude-code/*` and
  Codex presents `codex/*` under bare provider-native names, while both resolve
  through RouteKit's canonical catalog and managed account pool.
- Made `@fusionkit/cli` a Fusion-only front door over live namespaced RouteKit
  model IDs. Removed Fusion forwarding surfaces for account/proxy management,
  install/uninstall, provider/model/key flags, and direct/single-model mode.
- Reduced the PyPI `fusionkit` distribution to the internal
  `fusionkit-sidecar` command. The sidecar has no public chat/model routes or
  provider implementation; the separately installed `fusionkit-evals`
  distribution owns `fusionkit-bench`.
- Moved durable Fusion sessions, aggregate budgets, trajectories, and the public
  Fusion front door to `@fusionkit/gateway`; neutral per-call routing,
  provenance, and metering remain in `@routekit/gateway`.
- Added clean-install and OOTB command-shape gates for both CLIs, explicit npm
  and PyPI release dependency order, complete package/binary/version metadata,
  and Trusted Publisher validation for both npm scopes and all FusionKit PyPI
  projects.
- Hardened `@fusionkit/cli` observability releases by asserting the staged
  Scope standalone server exists and survives the strict package/install smoke.
- Updated canonical docs, generated API/behavior references, package metadata,
  and testkit fixtures for the completed RouteKit/FusionKit boundary.

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
