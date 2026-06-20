# Release coordinator reference

Details behind the `release` skill. The implementation is
`handoffkit/scripts/release.mjs`; the declarative state lives in
`handoffkit/release/`.

## State files (Terraform mapping)

| File | Terraform analog | Role |
|------|------------------|------|
| `release/workspace.release.json` | providers + resource graph | Static topology: per-unit repo, ecosystem, tag pattern, publish workflow, version sources, `dependsOn` edges, and the `tracked` (non-published) surfaces. |
| `release/desired.json` | config (`.tf`) | Target version per unit. Edited by hand or `release bump`. |
| `release/state.json` | `.tfstate` | Last-applied versions, written by `apply`, refreshed by `refresh`. A cache: `refresh` always trusts registries + git tags over it. |
| `release/.plans/*.plan.json` | `plan -out` artifact | Reviewable, ordered action graph. `apply` consumes the latest (or `--plan <file>`). Gitignored. |

## Commands

All commands accept `--json` (one JSON document on stdout; logs to stderr).

- `release refresh` — query npm (`npm view`), PyPI (`pypi.org/pypi/<pkg>/json`), and `git tag` for the actual released versions; write `state.json`.
- `release plan [-target=<unit>]` — refresh + diff desired vs actual into a DAG-ordered action list; print the diff; write a plan artifact. Read-only. Exit 1 on a downgrade.
- `release apply [--plan <file>] [--auto-approve] [--no-wait] [--include <path>] [--allow-dirty] [-target=<unit>]` — execute a plan in dependency order. Without `--auto-approve`, prints a preview and mutates nothing. `--no-wait` triggers releases and returns run URLs instead of blocking. `--include <path>` (repeatable) adds files to the release commit; `--allow-dirty` skips the clean-tree precondition (still only stages tool-touched + `--include` files).
- `release status [-target=<unit>] [--watch]` — per-unit published version, latest workflow run (id/status/conclusion/url), and all URLs. `--watch` blocks on in-flight runs.
- `release verify [-target=<unit>]` — confirm each unit's published version is >= desired. Exit 1 otherwise.
- `release graph` — print the dependency DAG / topological order.
- `release bump <unit> <version|major|minor|patch>` — edit `desired.json` (handles the `+structured.N` local segment for mlx-lm).

## URLs (what an agent listens to)

`plan`/`status`/`verify`/`refresh` emit a `urls` object per present unit: `slug`,
`repo`, `actions` (the publish workflow), `release` (the tag's release page), and
`registries[]` with `url` (npmjs.com / pypi.org). `apply` results add the live
`run.url` (the Actions run to poll) and `releaseUrl`. `state.json` records
`runUrl`/`releaseUrl` from the last apply.

## Controlling committed files

The release commit stages only files the tool changed (version sources, manifest,
CHANGELOG, propagated pins) — never `git add -A`. To add more: set
`extraCommitPaths: ["path", ...]` on a unit in `workspace.release.json`, or pass
`--include <path>` at apply time.

## Change kinds (plan symbols)

- `~` bump+publish — version changes and publishes.
- `+` publish — already at desired version locally but not yet released; publishes.
- `(blank)` no-op — already at desired version.
- `?` absent — repo not present in the workspace; skipped.
- `!` pin-lag / no-desired — protocol is changing but this consumer is not being released (keeps the old pin), or no desired version is set.

## Action types

`propagate-pin` -> `bump` -> `changelog` (handoffkit only) -> `commit` -> `push`
-> (`gh-release` | `tag` + `push-tag`) -> `wait-workflow`.

- `gh-release` is used for units whose publish workflow is gated on
  `release: published` (handoffkit, cursorkit, fusionkit-pypi, mlx-lm). The
  release is created already-published, which triggers the workflow.
- `tag` + `push-tag` is used for `fusionkit-protocol`, whose workflow triggers
  on a `model-fusion-protocol-v*` tag push.
- `wait-workflow` polls `gh run list`/`gh run watch` and blocks dependents until
  the publish succeeds.

## Ecosystem adapters

- `pnpm-monorepo` (handoffkit): lockstep bump of the root `package.json`, all 19
  publishable `@fusionkit/*` packages (read from `release/npm-packages.json`),
  and the manifest's `protocol.version`. Preserves the invariant in
  `scripts/check-release-publish.mjs`.
- `npm-single` (cursorkit): bump `package.json#version`.
- `uv-monorepo` (fusionkit-pypi): bump all member `pyproject.toml` versions and
  re-pin the `fusionkit-cli` internal `name==X` dependencies in lockstep.
- `protocol-dual` (fusionkit-protocol): bump the npm `package.json` and the
  Python `pyproject.toml` for `@velum-labs/model-fusion-protocol`.
- `python-single` (mlx-lm): rewrite `__version__` in `mlx_lm/_version.py`.

## Protocol pin propagation

When `fusionkit-protocol` changes and a consumer is being released, `apply`
updates that consumer's pin before committing:

- handoffkit: `@velum-labs/model-fusion-protocol` in root `package.json`
  devDependencies and the `TRUSTED_THIRD_PARTY` allowlist in
  `scripts/check-repo.mjs`.
- cursorkit: `package.json` dependencies/devDependencies and the
  `modelFusionProtocol.version` field.

A consumer that is not being released shows as `pin-lag` in the plan; bump it in
the same run to ship the new contract.

## Safety preconditions and guards

- `plan` refuses any unit whose desired version is older than the released
  version (shown as `x downgrade`) and exits non-zero.
- Before mutating each unit, `apply` asserts: on the expected branch, a clean
  working tree (no tracked changes; untracked files are allowed), up to date with
  the remote (not behind), and that the unit's declared/published versions still
  match what the plan recorded (drift detection — re-run `plan` if they moved).
- The release commit stages only the files the tool changed (never `git add -A`),
  so unrelated working-tree edits are never swept into a release.
- `wait-workflow` watches the run whose head SHA matches the commit/tag just
  pushed, not merely the latest run for that workflow.
- `apply -target=<unit>` automatically pulls in any actionable dependency of the
  target so a unit is never released against an upstream this run leaves
  unpublished.

## Idempotency and recovery

- A unit already at its desired published version is a no-op.
- Existing git tags / GitHub Releases are detected and skipped.
- `apply` stops at the first failed unit and records results in `state.json`;
  dependents are not released. Fix the cause, re-run `plan`, and `apply` again —
  already-completed units no-op.

## Tracked (non-published) surfaces

Declared under `tracked` in `workspace.release.json` for visibility only; this
tool never publishes them:

- `uniroute` — Python `uniroute`/`uniroute-mlx` (built/tested in CI, not published).
- `apps` — `apps/scope` (staged into `@fusionkit/cli`) and `apps/docs` (local only).
- `docker` — the Warrant image (built + smoke-tested in CI, never pushed).
