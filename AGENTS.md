# AGENTS.md

## Cursor Cloud specific instructions

This repo is a dual-stack monorepo: a **pnpm/TypeScript** workspace
(`packages/*`, `examples/*`) and a **uv/Python** workspace (`python/*`). The
shipped product is **FusionKit** (the `@fusionkit/cli` Node front door + the
Python `fusionkit serve` fusion/synthesis engine). The `warrant` governance
stack in `docker-compose.yml` / `Dockerfile` is **legacy / out of product
scope** (see `docs/scope.md`) and needs Docker, which is **not installed** here —
skip it unless explicitly asked.

### Node version gotcha (important)

The sandbox's default `node` (`/exec-daemon/node`) is **22.14.0**, which is too
old for this repo: `.npmrc` sets `engine-strict=true` and `undici` requires
Node `>=22.19.0`, so `pnpm install` fails against the default node. A newer
`node` (**22.22.2**, from nvm) is installed and satisfies the constraint. During
setup, `~/.bashrc` was edited to prepend `~/.nvm/versions/node/v22.22.2/bin` to
`PATH` so **login shells** (and the startup update script) resolve the correct
node/pnpm. If you run a command in a bare non-login shell and hit
`ERR_PNPM_UNSUPPORTED_ENGINE`, prepend that path yourself, e.g.
`export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"`.

`uv` lives in `~/.local/bin` (persisted via `~/.bashrc` / `~/.profile`).

### Standard commands (authoritative source: `.github/workflows/ci.yml`)

TypeScript workspace (`package.json` scripts):
- Install: `pnpm install --frozen-lockfile`
- Lint/check: `pnpm check` (runs `scripts/check-repo.mjs`; regenerates protocol bindings)
- Build: `pnpm build` (`tsc -b`); the `fusionkit` bin only links after a build
- Test: `pnpm test` (Node test runner over built `dist/`, so build first)

Python workspace (`pyproject.toml`):
- Sync: `uv sync --all-packages`
- Lint: `uv run ruff check .`  |  Type-check: `uv run pyright`
- Tests: `uv run pytest tests -q` (FusionKit) and `uv run pytest python -q` (uniroute)

### Docker (legacy `warrant` compose stack)

Docker is **not preinstalled** and does **not** work out of the box. The
`docker-compose.yml` / `Dockerfile` build the legacy `warrant` governance stack
(control plane + runner + control-panel UI on port 7172) — out of FusionKit
product scope, and not needed for FusionKit dev/test. It does build and pass the
CI docker smoke, but only after the Firecracker Docker-in-Docker workarounds:

1. Install `docker-ce`, `docker-compose-plugin`, `fuse-overlayfs`, `iptables` (sudo is passwordless).
2. `/etc/docker/daemon.json`: set `"storage-driver": "fuse-overlayfs"` **and**
   `"features": { "containerd-snapshotter": false }` — on Docker 29 the snapshotter
   must be disabled or fuse-overlayfs is ignored.
3. `update-alternatives --set iptables /usr/sbin/iptables-legacy` (and `ip6tables`).
4. Start the daemon manually (`sudo dockerd &`) — it is not a persisted service,
   so it must be restarted each session. Do **not** put dockerd or `docker compose up`
   in the startup update script.

Then `sudo docker compose build` + `sudo docker compose up -d --wait plane runner`
work; the Dockerfile's `node:22-bookworm-slim` base already satisfies the Node
engine floor, so the host Node caveat above does not apply inside the image.

### Running the fusion endpoint (dev)

The core product loop is easiest to exercise via the raw Python router rather
than the full Node orchestration (which pulls in `uvx`/portless):

```
uv run --package fusionkit fusionkit serve -c <config.yaml> --host 127.0.0.1 --port 8080
```

Then POST to `/v1/chat/completions` with model `fusionkit/panel` to trigger
panel fanout + synthesis (per-endpoint ids also work for passthrough). Notes:
- A real provider key is required. Only `OPENAI_API_KEY` is typically set here;
  `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` are not.
- `gpt-5.5` is a real model on the provided OpenAI account.
- The committed `.fusionkit/fusion.json` panel currently uses OpenRouter
  (`moonshotai/kimi-k2-thinking`, `qwen/qwen3-coder`) and requires
  `OPENROUTER_API_KEY`.
