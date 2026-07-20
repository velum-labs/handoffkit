# Operations and scripts

This page documents the repository's maintainer automation: root scripts, release state, generated code, CI workflows, dependency policy, local setup, and verification commands.

## Root command model

The root `package.json` is private and defines the TypeScript workspace commands. Use these from the repository root unless a section says to enter a standalone app.

| Command | What it does | When to run it |
| --- | --- | --- |
| `pnpm check` | Runs `scripts/check-repo.mjs`, committed Fusion/RouteKit config alignment, protocol package checks, generated OpenAPI SDK checks, generated code docs checks, expected-behavior checks, and release publish checks. | Before committing package, protocol, release, or documentation changes. |
| `pnpm build` | Runs `tsc -b tsconfig.json` across TypeScript project references. | After changing TypeScript packages or examples. |
| `pnpm build:cli` | Runs `tsc -b packages/cli` only. | For fast CLI-only rebuilds. |
| `pnpm build:routekit` | Runs `tsc -b packages/routekit-cli` only. | For fast RouteKit CLI-only rebuilds. |
| `pnpm clean` | Cleans TypeScript build outputs through project references. | When build output is stale or a package graph changed. |
| `pnpm test` | Runs compiled Node tests under packages, examples, and root `test/`. | After `pnpm build` when TypeScript behavior changed. |
| `pnpm test:root` | Runs only the root `test/*.test.js` suites. | For root-level test iteration. |
| `pnpm verify` | Runs `pnpm check`, `pnpm build`, and `pnpm test`. | Before release or broad behavior changes. |
| `pnpm demo` | Runs `scripts/demo.mjs`. | To execute one or more examples. |
| `pnpm demo all` | Runs every manifest-enabled non-interactive example. | Before changing example infrastructure. |
| `pnpm dev:link-cli` | Runs `scripts/link-fusionkit-dev.mjs` to link the `fusionkit-dev` wrapper globally. | To run this checkout's CLI from other repos. |
| `pnpm dev:run-cli` | Runs `scripts/fusionkit-dev.mjs`, rebuilding the local CLI before each run. | For dev-loop CLI runs. |
| `pnpm dev:link-routekit` | Runs `scripts/link-routekit-dev.mjs` to link the `routekit-dev` wrapper globally. | To run this checkout's RouteKit CLI from other repos. |
| `pnpm dev:run-routekit` | Runs `scripts/routekit-dev.mjs`, rebuilding the local RouteKit CLI before each run. | For RouteKit dev-loop CLI runs. |
| `pnpm mlx` / `pnpm mlx:stress` | Run the built `examples/mlx` smoke and stress tools. | On Apple Silicon when validating the managed-MLX path. |
| `pnpm docs:generate-code` | Regenerates `docs/generated/code-api.md` from TypeScript JSDoc and Python docstrings. | After changing package entry point comments or Python package docstrings. |
| `pnpm docs:check-code` | Checks that `docs/generated/code-api.md` is current. | Before committing source comment changes. |
| `pnpm docs:generate-behaviors` | Regenerates `docs/generated/expected-behaviors.md` from `spec/testing/expected-behaviors.json`. | After changing the expected-behavior inventory. |
| `pnpm docs:check-behaviors` | Checks that `docs/generated/expected-behaviors.md` is current. | Before committing behavior inventory changes. |
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

`uv run pytest` discovers tests under `tests` and `python`. Pyright is scoped to the FusionKit Python packages (including `python/fusionkit-testkit` and `python/hyperkit`), generated protocol Python code, scripts, and tests. `uniroute` and `uniroute-mlx` are in pytest discovery but intentionally outside the configured Pyright include list.

## Script reference

### `scripts/check-repo.mjs`

This is the main repository invariant check. It validates required files, dependency policy, model-fusion protocol package state, generated OpenAPI SDK output, generated code documentation output, and release publishing assumptions. It should remain fast enough to run on documentation and package changes.

Run:

```bash
pnpm check
```

If it fails because `node_modules` is absent, install dependencies from the lockfile before treating the failure as a code issue.

### `scripts/demo.mjs`

This script runs examples based on `examples/manifest.json` (currently one demo: `runtime-kernel`, id `15`). It supports all-example runs and targeted example runs by id.

Run:

```bash
pnpm build
pnpm demo all
pnpm demo 15
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

### `scripts/generate-code-docs.mjs`

This script reads TypeScript package entry point JSDoc and Python package
docstrings, then writes `docs/generated/code-api.md`. It also supports
`--check`, which `pnpm check` runs to prevent comment-derived docs from drifting.
When you change a public package entry point, update the source comment first,
then run:

```bash
pnpm docs:generate-code
pnpm docs:check-code
```

### Check scripts

`pnpm check` chains several focused checks alongside `scripts/check-repo.mjs`:

| Script | Purpose |
| --- | --- |
| `scripts/check-ootb-cli.mjs` | Out-of-the-box shape smoke for the published `routekit` and `fusionkit` CLIs: bin names, provider-based command surfaces, packaged files, and loud preflight failures. Run after `pnpm build`. |
| `scripts/check-fusion-router-alignment.mjs` | Fails when a provider prefix referenced by the committed Fusion ensembles is absent from the committed RouteKit router config. Runs as part of `pnpm check`. |
| `scripts/check-fusionkit-cli-pack.mjs` | Packs and clean-installs the FusionKit dependency closure. If a Scope bundle is staged, it verifies `scope/server.js` survives packing; release validation passes `--require-scope` to fail when staging was skipped. |
| `scripts/check-model-fusion-protocol.mjs` | Validates the model-fusion protocol package state. |
| `scripts/check-generated-model-fusion-sdk.mjs` | Checks the generated OpenAPI SDK outputs (TypeScript and Python) for drift. |
| `scripts/check-release-publish.mjs` | Validates release publishing assumptions. |

### Generator scripts

| Script | Purpose |
| --- | --- |
| `scripts/generate-trace-conventions.mjs` | Generates the fusion trace semantic-convention bindings from `spec/fusion-trace/registry.json`. |
| `scripts/generate-registry.mjs` | Generates the cross-language registry bindings from `spec/registry/*.json`. |
| `scripts/generate-pricing.mjs` | Refreshes and validates `spec/registry/pricing.json`. |
| `scripts/generate-local-catalog.mjs` | Refreshes and validates `spec/registry/local-catalog.json`. |
| `scripts/generate-model-fusion-openapi-sdk.mjs` | Generates the TypeScript and Python OpenAPI SDK bindings for the model-fusion contract. |
| `scripts/generate-expected-behaviors.mjs` | Renders `docs/generated/expected-behaviors.md` from `spec/testing/expected-behaviors.json` (`--check` for drift). |

### Python validation and utility scripts

| Script | Purpose |
| --- | --- |
| `scripts/validate_contract_fixtures.py` | Validates the model-fusion contract fixtures against the schemas. |
| `scripts/validate_protocol_package.py` | Validates the generated protocol package (including the schema bundle hash). |
| `scripts/validate_hyperkit_dashboards.py` | Validates Hyperkit dashboard contracts and executes every panel query (the CI `observability` job). |
| `scripts/build_protocol_python_package.py` | Builds the generated protocol Python package. |
| `scripts/mutation_pass.py` | Mutation pass proving the e2e suites are load-bearing (see [Testing](testing.md)). |
| `scripts/simple_openai_server.py` | Fronts one model endpoint (any provider) as an OpenAI Chat Completions server. |
| `scripts/simple_mlx_openai_server.py` | Minimal OpenAI-compatible server over a local MLX model. |
| `scripts/run_local_mlx_panel_demo.sh` | Drives the local MLX panel demo end to end (see [Local MLX panel demo](local-mlx-panel-demo.md)). |

### Dev-loop and release helper scripts

| Script | Purpose |
| --- | --- |
| `scripts/link-fusionkit-dev.mjs` | Links the `fusionkit-dev` wrapper globally (`pnpm dev:link-cli`). |
| `scripts/fusionkit-dev.mjs` | Rebuild-then-run wrapper for this checkout's CLI (`pnpm dev:run-cli`). |
| `scripts/link-routekit-dev.mjs` | Links the `routekit-dev` wrapper globally (`pnpm dev:link-routekit`). |
| `scripts/routekit-dev.mjs` | Rebuild-then-run wrapper for this checkout's RouteKit CLI (`pnpm dev:run-routekit`). |
| `scripts/publish-npm-workspaces.mjs` | Publishes the npm workspace packages during release workflows. |
| `scripts/sync-docs-changelog.mjs` | Regenerates the docs-site changelog page from the root `CHANGELOG.md` (`--check` for drift). |
| `scripts/stage-scope.mjs` | Copies the `apps/scope/.next/standalone` server plus static/public assets into `packages/cli/scope`, removes build-time state, and asserts the staged `server.js` exists. Run it only after building `apps/scope`. |

### Fusion end-to-end scripts

Scripts with names like `scripts/fusion-*-e2e.mjs` exercise specific harness or fusion flows. Use them when changing tool launchers, gateway dialects, frontdoor behavior, or CLI orchestration.

| Script | Purpose |
| --- | --- |
| `scripts/fusion-codex-e2e.mjs` | Real end-to-end driver using the codex CLI as the front-door harness. |
| `scripts/fusion-claude-e2e.mjs` | Real end-to-end driver using Claude Code as the front-door harness. |
| `scripts/fusion-step-e2e.mjs` | Real end-to-end driver for the judge-streamed-trajectory front door. |
| `scripts/fusion-observe-verify.mjs` | Full-stack verification: scope dashboard + real codex session + collector correlation. |
| `scripts/otlp-capture.mjs` | Tiny in-script OTLP/HTTP JSON collector used by the e2e drivers. |

Because these scripts may depend on local CLIs, provider keys, or platform capabilities, document the environment assumptions in the related CLI or gateway docs when changing them.

### `scripts/monorepo.mjs`

This script backs the `pnpm mono` helper: internal dependency graph inspection (`graph`) and scoped build + test for packages changed against a base (`affected`). Use it for workspace operations that should be consistent across packages rather than ad hoc shell loops.

### Benchmark and infra tooling

Benchmark execution lives in `python/fusionkit-evals` behind the maintainer-only
`fusionkit-bench` entrypoint: `fusionkit-bench public`,
`fusionkit-bench tune-prompts`, and `fusionkit-bench fusion`;
[Benchmarking runbook](benchmarking-runbook.md) is the workflow doc. Hyperkit
infra deploy scripts live at `infra/hypergrid-batch/deploy.py` and
`infra/hypergrid-obs/deploy.py`; see [Hyperkit](hyperkit.md).

## Release files

The `release/` directory stores desired release state, observed state, package lists, and release graph metadata. It is operational state, not product runtime code. `apps/scope` is tracked as source but its standalone output is staged into the published `@fusionkit/cli` tarball; `apps/docs` is deployed separately and is not a package release unit.

Important files include:

| File | Purpose |
| --- | --- |
| `release/desired.json` | Desired package versions and release targets. |
| `release/state.json` | Local gitignored release-state cache regenerated with `node scripts/release.mjs refresh`. |
| `release/workspace.release.json` | Workspace release metadata and package ordering. |
| `release/npm-packages.json` | Published npm package list. |

When changing release files, update release documentation and run `pnpm release:plan`. When changing package versions or protocol package pins, verify that consumers resolve the intended versions.

## Dependency policy

The repository allows third-party dependencies, but they must be explicit, reviewed, pinned, and compatible with the allowlist enforced by `scripts/check-repo.mjs`. The `.npmrc` policy uses exact saves, frozen lockfile installs, integrity verification, script restrictions, and a release-age policy.

When adding a dependency, use the relevant package manager and latest safe version. For npm packages, update the package manifest and lockfile through pnpm. For Python packages, update the relevant `pyproject.toml` and `uv.lock` through uv. Then update dependency allowlists if the repository check requires it.

Do not bypass dependency checks by editing generated lockfile sections manually. The reviewable artifact should show the package manager's normal output plus any explicit allowlist changes.

## CI workflow map

Workflows live under `.github/workflows/`. `ci.yml` defines five jobs:

| Job | What it runs |
| --- | --- |
| `check` | `pnpm check`, `pnpm build`, the OOTB CLI shape smoke, `pnpm test`, `pnpm demo all`, and a dependency audit. |
| `scope` | Build and tests for the `apps/scope` observability app from its own workspace. |
| `stack-e2e` | The cross-stack suites: Node gateway + real Python sidecar + simulated RouteKit/provider upstreams, plus the real `claude`/`codex`/`opencode` binaries. |
| `python` | uv lockfile check, sync, Ruff, Pyright, uniroute and FusionKit pytest suites, contract fixture validation, and PyPI metadata smoke. |
| `observability` | Hyperkit Grafana dashboard validation: boots seeded Prometheus and Grafana and executes every panel query via `scripts/validate_hyperkit_dashboards.py`. |

The release workflows are `release-packages.yml` (npm), `pypi-release.yml`, and `model-fusion-protocol-release.yml` (protocol publication). There is no docs-deployment workflow; the docs site deploys through its own Vercel configuration.

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

For docs-only changes under `docs/`, run `pnpm check`. For content changes under `apps/docs`, also build the docs app. For generated API docs, regenerate OpenAPI content or source-comment content and inspect the generated output before committing.

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
