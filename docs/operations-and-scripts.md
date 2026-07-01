# Operations and scripts

This page documents the repository's maintainer automation: root scripts, release state, generated code, CI workflows, dependency policy, local setup, and verification commands.

## Root command model

The root `package.json` is private and defines the TypeScript workspace commands. Use these from the repository root unless a section says to enter a standalone app.

| Command | What it does | When to run it |
| --- | --- | --- |
| `pnpm check` | Runs `scripts/check-repo.mjs`, protocol package checks, generated OpenAPI SDK checks, and release publish checks. | Before committing package, protocol, release, or documentation changes. |
| `pnpm build` | Runs `tsc -b tsconfig.json` across TypeScript project references. | After changing TypeScript packages or examples. |
| `pnpm clean` | Cleans TypeScript build outputs through project references. | When build output is stale or a package graph changed. |
| `pnpm test` | Runs compiled Node tests under packages, examples, and root `test/`. | After `pnpm build` when TypeScript behavior changed. |
| `pnpm verify` | Runs `pnpm check`, `pnpm build`, and `pnpm test`. | Before release or broad behavior changes. |
| `pnpm demo` | Runs `scripts/demo.mjs`. | To execute one or more examples. |
| `pnpm demo all` | Runs every manifest-enabled non-interactive example. | Before changing example infrastructure. |
| `pnpm release:plan` | Runs release planning through `scripts/release.mjs plan`. | Before release state changes. |
| `pnpm release:apply` | Applies release changes through `scripts/release.mjs apply`. | Only when intentionally performing a release workflow. |
| `pnpm release:graph` | Prints release dependency graph information. | To inspect release ordering. |
| `pnpm release:refresh` | Refreshes release state. | When release metadata needs synchronization. |
| `pnpm mono` | Runs `scripts/monorepo.mjs`. | For workspace helper operations. |

## Python command model

The root `pyproject.toml` is a uv workspace. Use these commands from the repository root:

```bash
uv sync --all-packages
uv run pytest
uv run pyright
uv run ruff check .
```

`uv run pytest` discovers tests under `tests` and `python`. Pyright is scoped to FusionKit Python packages, generated protocol Python code, scripts, and tests. `uniroute` and `uniroute-mlx` are in pytest discovery but intentionally outside the configured Pyright include list.

## Script reference

### `scripts/check-repo.mjs`

This is the main repository invariant check. It validates required files, dependency policy, model-fusion protocol package state, generated OpenAPI SDK output, and release publishing assumptions. It should remain fast enough to run on documentation and package changes.

Run:

```bash
pnpm check
```

If it fails because `node_modules` is absent, install dependencies from the lockfile before treating the failure as a code issue.

### `scripts/demo.mjs`

This script runs examples based on `examples/manifest.json`. It supports all-example runs and targeted example runs.

Run:

```bash
pnpm build
pnpm demo all
pnpm demo governed-run
```

When adding an example, update the manifest and [Apps and examples](apps-and-examples.md).

### `scripts/release.mjs`

This script coordinates cross-package releases. It supports planning, applying, graph inspection, and refresh operations. It reads and writes files under `release/`, and it must be used carefully because release state affects published npm and PyPI package workflows.

Run dry inspection first:

```bash
pnpm release:plan
pnpm release:graph
```

Apply only when intentionally performing a release:

```bash
pnpm release:apply
```

### `scripts/generate_protocol_codegen.py`

This script regenerates protocol bindings from schemas and OpenAPI contracts. It writes generated TypeScript and Python protocol files.

Run:

```bash
uv run python scripts/generate_protocol_codegen.py
```

After running it, inspect generated diffs and run protocol-related tests. Do not hand-edit generated protocol files.

### Fusion end-to-end scripts

Scripts with names like `scripts/fusion-*-e2e.mjs` exercise specific harness or fusion flows. Use them when changing tool launchers, gateway dialects, frontdoor behavior, or CLI orchestration.

Because these scripts may depend on local CLIs, provider keys, or platform capabilities, document the environment assumptions in the related CLI or gateway docs when changing them.

### `scripts/monorepo.mjs`

This script backs the `pnpm mono` helper. Use it for workspace operations that should be consistent across packages rather than ad hoc shell loops.

## Release files

The `release/` directory stores desired release state, observed state, package lists, and release graph metadata. It is operational state, not product runtime code.

Important files include:

| File | Purpose |
| --- | --- |
| `release/desired.json` | Desired package versions and release targets. |
| `release/state.json` | Current known release state. |
| `release/workspace.release.json` | Workspace release metadata and package ordering. |
| `release/npm-packages.json` | Published npm package list. |

When changing release files, update release documentation and run `pnpm release:plan`. When changing package versions or protocol package pins, verify that consumers resolve the intended versions.

## Dependency policy

The repository allows third-party dependencies, but they must be explicit, reviewed, pinned, and compatible with the allowlist enforced by `scripts/check-repo.mjs`. The `.npmrc` policy uses exact saves, frozen lockfile installs, integrity verification, script restrictions, and a release-age policy.

When adding a dependency, use the relevant package manager and latest safe version. For npm packages, update the package manifest and lockfile through pnpm. For Python packages, update the relevant `pyproject.toml` and `uv.lock` through uv. Then update dependency allowlists if the repository check requires it.

Do not bypass dependency checks by editing generated lockfile sections manually. The reviewable artifact should show the package manager's normal output plus any explicit allowlist changes.

## CI workflow map

Workflows live under `.github/workflows/`. They cover repository checks, builds, tests, demos, docs deployment, npm release, PyPI release, and protocol publication.

When a local check fails in CI but passes locally, compare the workflow's Node, pnpm, Python, and uv versions first. Then compare environment variables and optional service credentials. Do not assume a CI-only failure is flaky until the workflow logs show an external service or network error.

Common local equivalents:

| CI concern | Local command |
| --- | --- |
| Repository invariants | `pnpm check` |
| TypeScript compile | `pnpm build` |
| Node unit tests | `pnpm test` after build |
| Full TypeScript verify | `pnpm verify` |
| Python unit tests | `uv run pytest` |
| Python type check | `uv run pyright` |
| Python lint | `uv run ruff check .` |
| Docs site build | `cd apps/docs && pnpm build` |
| Scope app tests | `cd apps/scope && pnpm test` |

## Local setup notes

The expected Node version is at least the root `engines.node` value, and individual dependencies may require a newer patch version. If `pnpm install --frozen-lockfile` fails with an engine error, update the local Node runtime rather than changing repository metadata. For temporary local verification in an isolated agent environment, engine strictness can be disabled without committing any lockfile or manifest changes, but that should be reported in the verification notes.

The root pnpm workspace covers `packages/*` and `examples/*`. The apps under `apps/docs` and `apps/scope` have their own lockfiles and should be installed separately.

The uv workspace covers `python/*` and shares one committed `uv.lock`. The root is virtual, so package commands should use `uv run --package <name>` when there is ambiguity.

## Documentation operations

Maintainer docs live under `docs/`. User-facing docs live under `apps/docs/content/docs/`. If a concept appears in both places, the public site should contain the user-facing path and the maintainer docs should contain implementation detail.

For docs-only changes under `docs/`, run `pnpm check`. For content changes under `apps/docs`, also build the docs app. For generated API docs, regenerate OpenAPI content and inspect the generated output before committing.

## Verification strategy

Choose verification based on the changed surface:

| Changed surface | Minimum verification |
| --- | --- |
| `docs/` only | `pnpm check` |
| `apps/docs` | `cd apps/docs && pnpm build` |
| TypeScript source | `pnpm build` and focused compiled tests |
| TypeScript source with broad package impact | `pnpm verify` |
| Python source | `uv run pytest`, `uv run pyright`, and `uv run ruff check .` as relevant |
| Protocol schemas | Codegen, `pnpm check`, TypeScript build, and Python protocol tests |
| Examples | `pnpm build` and targeted `pnpm demo <name>` |
| Release state | `pnpm release:plan` and `pnpm check` |

## Recovery guidance

If generated files changed unexpectedly, rerun the generator from a clean tree and compare the diff. If output is still unexpected, inspect the generator inputs before editing generated files.

If `pnpm check` fails in the model-fusion protocol check, verify that `node_modules/@velum-labs/model-fusion-protocol` exists and matches the version pinned in the root manifest. Then inspect local generated files for drift.

If examples fail because compiled files are missing, run `pnpm build` first. If example binaries fail to link during install, build the CLI package and rerun the example command.

If Python tests fail because optional MLX dependencies are unavailable, confirm whether the test should be skipped on the current platform or whether the import boundary has become too eager.

If docs site build fails after MDX edits, check frontmatter, escaped braces in JSX or Mermaid blocks, and links to pages that may not exist in Fumadocs navigation.
