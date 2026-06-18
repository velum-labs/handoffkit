# Getting started

## Requirements

- Node.js `>=22.0.0`
- pnpm `>=10.33.4`
- Docker, if you want the compose stack or containerized demos
- uv, optional but recommended for the Python UniRoute workspace and managed MLX

## Install and verify

```sh
pnpm install
pnpm check
pnpm build
pnpm test
```

`pnpm verify` runs `check`, `build`, and `test` in sequence.

## Initialize local state

```sh
pnpm build
warrant init
```

The CLI stores local plane configuration, signing keys, and encrypted secret
state under the Warrant home directory managed by `packages/cli/src/config.ts`.

## Run the local plane and runner

In separate terminals:

```sh
warrant plane start
warrant runner start
```

Then request a governed run:

```sh
warrant run --agent mock "summarize the repository layout"
warrant runs
warrant receipt <run-id>
warrant verify <run-id>
```

Use real agent harnesses by selecting an agent kind and releasing only the
required secrets and egress hosts through policy:

```sh
warrant secrets set ANTHROPIC_API_KEY sk-ant-...
warrant run --agent claude-code --secret ANTHROPIC_API_KEY \
  --allow-host api.anthropic.com "fix the flaky auth test and run the suite"
```

## Docker compose

The compose stack starts the plane, runner, and seeded showcase data:

```sh
docker compose up --build
docker compose exec plane warrant ui
docker compose exec plane warrant runs
```

Open the control panel at `http://localhost:7172/ui/`.

## Demo suite

List and run standalone scenarios:

```sh
pnpm demo
pnpm demo 01
pnpm demo 08
```

The demo manifest lives at `examples/manifest.json`; shared narration and live
model helpers live in `packages/example-utils`.

## Python workspace

The repository is also a uv workspace for UniRoute:

```sh
uv sync --all-packages
uv run --package uniroute python -m uniroute.demo
uv run pytest python/uniroute/tests
```

See `python/uniroute/README.md` and `python/uniroute-mlx/README.md` for routing
details.
