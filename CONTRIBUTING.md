# Contributing

Thanks for helping make FusionKit better. Keep changes focused, practical, and easy to review.

## Prerequisites

- Node.js `>=22.19.0`; this repo uses `engine-strict` and newer dependencies require a recent Node 22 patch.
- Corepack with the pinned pnpm from `packageManager` in the root `package.json`.
- `uv` for the Python workspace.
- Git, plus any coding-agent CLI needed for manual harness testing.

## TypeScript workflow

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test
pnpm verify
```

`pnpm check` runs `scripts/check-repo.mjs`, protocol checks, generated docs checks, and release publish checks. Any file add, move, or delete can require a matching update to `scripts/check-repo.mjs`; treat that script as the repository manifest.

## Python workflow

```sh
uv sync --all-packages
uv run ruff check .
uv run pyright
uv run pytest tests -q
uv run pytest python -q
```

Use `uv run --package <name> ...` when a command belongs to a specific Python package.

## Generated files

Do not hand-edit generated files. Regenerate them and inspect the diff instead:

- `pnpm docs:generate-code` regenerates `docs/generated/code-api.md`.
- `pnpm docs:check-code` verifies `docs/generated/code-api.md` is current.
- `pnpm --dir spec/model-fusion-contract generate` regenerates protocol TypeScript and Python bindings.
- `pnpm --dir spec/model-fusion-contract check:generated` verifies generated protocol outputs.

## Dependency policy

Third-party npm dependencies must be exact-pinned and present in the allowlist enforced by `scripts/check-repo.mjs`. Bumping a dependency means updating the manifest, lockfile, and allowlist pin together. For Python dependencies, update the relevant `pyproject.toml` and `uv.lock` through `uv` rather than editing lockfile sections by hand.

## Pull requests

- Keep one logical change per commit.
- Explain user-visible behavior and compatibility impact in the PR summary.
- List the exact checks you ran.
- Keep CI green before asking for review.
- Update the check-repo manifest when files are moved, added, or removed.
