# Getting started

## Requirements

- Node.js `>=22.0.0`
- pnpm `>=10.33.4`
- Docker, if you want the compose stack or containerized demos
- uv, optional but recommended for the Python UniRoute workspace and managed MLX
- [portless](https://github.com/vercel-labs/portless) `>=0.14` (Node `>=24`), recommended for stable named URLs (see below)

## Portless (stable named URLs)

Every service the fusion stack starts — the scope dashboard, the gateway your
coding agent connects to, the `fusionkit serve` router, and the control panel —
is registered with [portless](https://github.com/vercel-labs/portless) so it is
reachable at a stable HTTPS name (e.g. `https://scope.localhost`,
`https://gateway.fusion.localhost`) instead of a raw port. Named services are
also reused across runs (discover-or-spawn singletons).

One-time setup (needs Node `>=24`):

```sh
npm install -g portless
portless service install   # run the HTTPS proxy at OS startup
portless trust             # add the local CA to your system trust store
```

Then `fusionkit codex|claude|cursor|serve` and `fusionkit plane start` print
`https://*.localhost` URLs automatically. To opt out for a run (raw loopback
ports, e.g. in CI), pass `--no-portless` or set `PORTLESS=0`. When portless is
not installed (Node `<24`) the stack transparently falls back to ports.

Reap persistent singletons left running by prior runs with `fusionkit fusion stop`.

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
fusionkit init
```

The CLI stores local plane configuration, signing keys, and encrypted secret
state under the fusionkit home directory (`./.fusionkit`) managed by
`packages/cli/src/config.ts`.

## Run the local plane and runner

In separate terminals:

```sh
fusionkit plane start
fusionkit runner start
```

Then request a governed run:

```sh
fusionkit run --agent mock "summarize the repository layout"
fusionkit runs
fusionkit receipt <run-id>
fusionkit verify <run-id>
```

Use real agent harnesses by selecting an agent kind and releasing only the
required secrets and egress hosts through policy:

```sh
fusionkit secrets set ANTHROPIC_API_KEY sk-ant-...
fusionkit run --agent claude-code --secret ANTHROPIC_API_KEY \
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
