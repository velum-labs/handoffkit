---
name: release
description: >-
  Coordinates cross-repo releases for the velum-labs workspace (handoffkit,
  cursorkit, fusionkit, mlx-lm) using a Terraform-style plan/apply flow. Use
  when asked to "cut a release", "release", "ship velum", "publish packages",
  "plan a release", "apply a release", "bump and publish", or to roll out a new
  @velum-labs/model-fusion-protocol version across its consumers. Drives
  scripts/release.mjs (plan/apply/refresh/graph/bump) which bumps versions in
  dependency order, propagates the protocol pin, and triggers each repo's own
  publish workflow.
---

# Cross-repo release (plan / apply)

This skill cuts releases across the four publishable velum-labs repos. It is
modeled on Terraform: you declare desired versions, `plan` shows an ordered
diff, and `apply` executes it idempotently. The tool never publishes directly —
it triggers each repo's existing, gated GitHub publish workflow.

All commands run from the `handoffkit` repo root.

## Agent usage (`--json`)

Every command accepts `--json` and prints exactly one JSON document to stdout
(human logs go to stderr). Prefer this when driving the tool programmatically.
Useful fields: per-unit `changeKind`, `actions`, `urls` (repo, actions,
release, registry), and after apply, `run.url` / `releaseUrl` to listen to.
Exit code is non-zero on downgrade (`plan`), failure (`apply`), or unmet
expectations (`verify`).

Recommended non-blocking loop for an agent:

```bash
node scripts/release.mjs plan --json                       # review the diff + URLs
node scripts/release.mjs apply --auto-approve --no-wait --json   # trigger; returns run URLs
node scripts/release.mjs status --json                     # poll run status/conclusion
node scripts/release.mjs verify --json                     # confirm published >= desired
```

`--no-wait` triggers each release and returns immediately with the workflow run
URL per unit instead of blocking on `gh run watch`; poll with `status`.

## Release units and order

The dependency graph (in `release/workspace.release.json`) drives the order:

```
fusionkit-protocol  ->  fusionkit-pypi  ->  mlx-lm
                    ->  cursorkit
                    ->  handoffkit
```

`fusionkit-protocol` (`@velum-labs/model-fusion-protocol`) is the contract that
`handoffkit` and `cursorkit` pin. When it changes, the new pin is propagated
into the consumers that are being released in the same plan.

## Workflow

Follow these steps. Show the user the plan and get confirmation before applying.

1. Reconcile state with reality:

```bash
node scripts/release.mjs refresh
```

2. Make sure the `## Unreleased` section of `CHANGELOG.md` describes what is
   shipping (for units with a changelog — currently handoffkit). Apply promotes
   it to the version heading, uses it as the GitHub Release notes, and
   regenerates the docs changelog page; if it is empty a stub entry is written
   and a warning printed.

3. Set the desired version(s). Edit `release/desired.json` directly, or:

```bash
node scripts/release.mjs bump <unit> <patch|minor|major|X.Y.Z>
```

Units: `fusionkit-protocol`, `fusionkit-pypi`, `cursorkit`, `handoffkit`, `mlx-lm`.

4. Produce the plan and present the diff to the user:

```bash
node scripts/release.mjs plan          # add -target=<unit> to scope
```

Summarize what will bump, what pin propagates, and what publishes. If the plan
prints a `pin-lag` warning (protocol changing but a consumer not being
released), tell the user and offer to bump that consumer too.

5. Confirm with the user. Releases are irreversible (they publish to npm/PyPI).

6. Apply:

```bash
node scripts/release.mjs apply --auto-approve            # blocking: waits for each workflow
# or, to drive it yourself:
node scripts/release.mjs apply --auto-approve --no-wait  # returns run URLs immediately
```

`apply` runs in dependency order, commits + pushes each repo, creates the
publishing GitHub Release (or pushes the tag, for the protocol), and (unless
`--no-wait`) waits for each publish workflow before starting dependents. Without
`--auto-approve` it prints a preview and makes no changes.

To control exactly what the release commit includes: set `extraCommitPaths` per
unit in `release/workspace.release.json`, or pass `--include <path>` (repeatable)
at apply time. If you have intentionally staged other edits, add `--allow-dirty`
(only tool-touched + `--include` files are staged regardless).

7. Report the per-unit apply summary, including any failure (apply stops at the
first failure so dependents are not released against a broken upstream).

## Important constraints

- Never edit version files by hand for a release — always go through
  `bump` + `plan` + `apply` so the lockstep invariants and pin propagation hold.
- Requires `gh` (authenticated) and push access to each repo.
- `fusionkit-sandbox` is intentionally out of scope (publishes nothing).
- Tracked-only surfaces (Python `uniroute`, `apps/*`, the Docker image) appear
  for visibility but are never published by this tool.

See `reference.md` for the action types, idempotency/recovery behavior, the
ecosystem adapters, and the tracked surfaces.
