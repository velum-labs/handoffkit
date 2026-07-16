# Getting started

This page is the maintainer-oriented setup path for working on FusionKit from a
checkout. If you only want to use the product, start with the root
[README](../README.md), the published docs in [`apps/docs`](../apps/docs), or the
task quickstarts for [coding harnesses](quickstart-harness.md) and the
[inference endpoint](quickstart-inference.md).

FusionKit's shipped product is the Node `@fusionkit/cli` front door plus its
internal Python `fusionkit-sidecar` synthesis process. The legacy Warrant governance plane,
Docker compose stack, runner, receipt, and VM-isolation packages are retained in
the repository but are out of product scope; see [Product scope](scope.md).

## Requirements

- Node.js `>=22.19.0` for dependency installs in this repo. In this environment,
  use the installed Node `22.22.2` path if a non-login shell resolves the older
  sandbox Node: `export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"`.
- pnpm `>=10.33.4`, normally activated through Corepack from the root
  `packageManager` field.
- `uv` for the Python workspace and for exercising the Python fusion endpoint.
- Provider keys referenced by `.routekit/router.yaml` when you run cloud
  endpoints. This checkout uses OpenRouter and therefore needs
  `OPENROUTER_API_KEY`; FusionKit itself does not read provider credentials.
- A coding harness CLI (`codex`, `claude`, or `cursor-agent`) when testing the
  harness-backed product path.
- Docker only if you are explicitly working on the legacy compose stack. Docker
  is not required for FusionKit development and is not installed in the default
  sandbox.

## Install and verify the TypeScript workspace

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test
```

`pnpm verify` runs `check`, `build`, and `test` in sequence. `pnpm check`
regenerates protocol bindings as part of the repository invariant checks.

To run this checkout's CLI from any target repo, link the development command:

```sh
pnpm dev:link-cli
fusionkit-dev --version
```

Then launch it from a separate git repository:

```sh
cd /path/to/target-repo
fusionkit-dev doctor
fusionkit-dev codex
```

`fusionkit-dev` rebuilds the local CLI before each run. After a successful build,
set `FUSIONKIT_DEV_SKIP_BUILD=1` for faster repeated checks.

## Python workspace

The repository is also a uv workspace under `python/*`:

```sh
uv sync --all-packages
uv run ruff check .
uv run pyright
uv run pytest tests -q
uv run pytest python -q
```

To exercise the internal synthesis sidecar during development, use a config
that names the RouteKit URL and opaque endpoint IDs:

```sh
uv run --package fusionkit fusionkit-sidecar serve \
  -c <config.yaml> --host 127.0.0.1 --port 8080
```

Use `/health` for readiness and `/v1/fusion/trajectories:fuse` for an internal
fusion step. Public chat, messages, responses, model listing, and passthrough
remain on the Node gateway started by `fusionkit serve`.

## Product quick checks

```sh
fusionkit doctor
fusionkit init
fusionkit config show
fusionkit codex      # or: fusionkit claude | cursor | opencode
fusionkit serve      # gateway/raw endpoint path
```

The committed `.fusionkit/fusion.json` v4 file contains only ensembles of
opaque RouteKit endpoint IDs and Fusion policy. Provider models, URLs, and key
environment references live in `.routekit/router.yaml`; prompt overrides remain
in `.fusionkit/prompts/*.md`.

## Portless (stable named URLs)

Fusion-owned services, including the scope dashboard and the gateway your coding
agent connects to, can use
[portless](https://github.com/vercel-labs/portless) for stable local HTTPS names
instead of raw ports. Named services are also reused across runs
(discover-or-spawn singletons).

One-time setup (needs Node `>=24`):

```sh
npm install -g portless
portless service install   # run the HTTPS proxy at OS startup
portless trust             # add the local CA to your system trust store
```

Then `fusionkit codex|claude|cursor|opencode|serve` print
`https://*.localhost` URLs automatically. To opt out for a run (raw loopback
ports, e.g. in CI), pass `--no-portless` or set `PORTLESS=0`. When portless is
not installed (Node `<24`) the stack transparently falls back to ports.

Reap persistent singletons left running by prior runs with the top-level
`fusionkit stop`.

## Legacy Docker compose

The compose stack starts the out-of-scope Warrant plane, runner, and seeded
showcase data. It is preserved for legacy governance work only and is not part of
normal FusionKit development.

```sh
docker compose -f legacy/docker/docker-compose.yml up --build
# Inside the legacy Docker image, use the archived entrypoint for UI/runs commands.
```

Open the control panel at `http://localhost:7172/ui/`.

## Demo suite

List and run standalone scenarios (the manifest currently holds one demo,
`runtime-kernel`, id `15`; `pnpm demo all` runs it):

```sh
pnpm demo
pnpm demo 15
pnpm demo all
```

The demo manifest lives at `examples/manifest.json`; shared narration and live
model helpers live in `packages/example-utils`.

## Experiment platform

For benchmark experiments at scale, the Hyperkit experiment platform is
documented in [Hyperkit](hyperkit.md), and the shared experiment lab's
operating procedures live in [`lab/AGENTS.md`](../lab/AGENTS.md).
