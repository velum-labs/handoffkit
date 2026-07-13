# Getting started

This page is the maintainer-oriented setup path for working on FusionKit from a
checkout. If you only want to use the product, start with the root
[README](../README.md), the published docs in [`apps/docs`](../apps/docs), or the
task quickstarts for [coding harnesses](quickstart-harness.md) and the
[inference endpoint](quickstart-inference.md).

FusionKit's shipped product is the Node `@fusionkit/cli` front door plus the
Python `fusionkit serve` fusion engine. The legacy Warrant governance plane,
Docker compose stack, runner, receipt, and VM-isolation packages are retained in
the repository but are out of product scope; see [Product scope](scope.md).

## Requirements

- Node.js `>=22.19.0` for dependency installs in this repo. In this environment,
  use the installed Node `22.22.2` path if a non-login shell resolves the older
  sandbox Node: `export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"`.
- pnpm `>=10.33.4`, normally activated through Corepack from the root
  `packageManager` field.
- `uv` for the Python workspace and for exercising the Python fusion endpoint.
- Provider keys when you run real cloud panels. `OPENAI_API_KEY` is enough for an
  OpenAI-only config; the default cloud trio also looks for `ANTHROPIC_API_KEY`
  and `GEMINI_API_KEY`. Those built-in defaults apply to fresh repos: this
  repository's committed `.fusionkit/fusion.json` panel uses OpenRouter models,
  so working inside this checkout needs `OPENROUTER_API_KEY`.
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

To exercise the raw fusion endpoint directly during development, use a config
whose endpoints are available on your machine:

```sh
uv run --package fusionkit fusionkit serve -c <config.yaml> --host 127.0.0.1 --port 8080
```

Then POST to `/v1/chat/completions` with model `fusionkit/panel`, or use a
specific endpoint id for passthrough.

## Product quick checks

```sh
fusionkit doctor
fusionkit init
fusionkit status
fusionkit codex      # or: fusionkit claude | fusionkit cursor
fusionkit serve      # gateway/raw endpoint path
```

The committed `.fusionkit/` folder is the product config source of truth. Edit
`.fusionkit/fusion.json` for panels, judge, tool defaults, and run defaults; edit
`.fusionkit/prompts/*.md` for prompt overrides. The Python router YAML is derived
from that config, not hand-maintained separately.

## Portless (stable named URLs)

Every service the fusion stack starts, including the scope dashboard, the gateway
your coding agent connects to, and the `fusionkit serve` router, can use
[portless](https://github.com/vercel-labs/portless) for stable local HTTPS names
instead of raw ports. Named services are also reused across runs
(discover-or-spawn singletons).

One-time setup (needs Node `>=24`):

```sh
npm install -g portless
portless service install   # run the HTTPS proxy at OS startup
portless trust             # add the local CA to your system trust store
```

Then `fusionkit codex|claude|cursor|serve` print
`https://*.localhost` URLs automatically. To opt out for a run (raw loopback
ports, e.g. in CI), pass `--no-portless` or set `PORTLESS=0`. When portless is
not installed (Node `<24`) the stack transparently falls back to ports.

Reap persistent singletons left running by prior runs with the top-level
`fusionkit stop` (or the equivalent `fusionkit fusion stop`).

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
