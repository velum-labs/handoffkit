# AGENTS.md

## Cursor Cloud specific instructions

This repo is a dual-stack monorepo: a **pnpm/Turborepo Node** workspace
(`packages/*`, `examples/*`, `apps/*`) and a **uv/Python** workspace (`python/*`). The
shipped products are **RouteKit** (the independent `@velum-labs/routekit` Node router)
and **FusionKit** (the `@fusionkit/cli` Node front door + internal Python
`fusionkit-sidecar` synthesis process). The `warrant` governance
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

Node workspace (`package.json` scripts):
- Install: `pnpm install --frozen-lockfile`
- Lint/check: `pnpm check` (runs `scripts/check-repo.mjs`; regenerates protocol bindings)
- Build: `pnpm build` (Turbo runs per-package `tsc -b` and both Next.js app builds)
- Test: `pnpm test` (Turbo builds dependencies before package and app tests)
- Filter: `pnpm exec turbo run build --filter=<package>...`

Python workspace (`pyproject.toml`):
- Sync: `uv sync --all-packages --extra aws` (keeps Hyperkit's AWS backend installed)
- Lint: `uv run ruff check .`  |  Type-check: `uv run pyright`
- Tests: `uv run pytest tests -q` (FusionKit) and `uv run pytest python -q` (uniroute)

### Hyperkit environment (`velum-mini`)

This worker is configured for local Hyperkit orchestration and AWS-backed runs:

- `AWS_PROFILE=cursor-agent-infra`, `AWS_DEFAULT_REGION=us-east-1`, and
  `AWS_REGION=us-east-1` are loaded for new shells. The profile assumes the
  `cursor-agent-infra` role through the local `cursor-bootstrap` profile.
- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `OPENROUTER_API_KEY` are loaded
  from `~/.config/hyperkit/secrets.env` (mode `0600`). `GEMINI_API_KEY` is not
  configured.
- Never print, copy into repository files, or commit credential values. Check
  availability by testing whether a variable is set, without echoing its value.
- Local credentials are not automatically inherited by AWS Batch containers;
  cloud jobs must receive provider keys through the stack's Secrets Manager
  integration.

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

### Running FusionKit (dev)

The public OpenAI-compatible gateway belongs to the Node CLI:

```
fusionkit serve --no-portless --port 8080
```

The Node process starts the internal Python sidecar and sends it completed
trajectories. To debug only that internal process, use
`uv run --package fusionkit fusionkit-sidecar serve -c <sidecar.yaml>` and
probe `/health`; it intentionally has no public chat or model routes. Notes:
- The RouteKit gateway needs the provider keys referenced by its router config;
  the sidecar itself receives no provider credentials. `OPENAI_API_KEY`,
  `ANTHROPIC_API_KEY`, and `OPENROUTER_API_KEY` are configured on `velum-mini`;
  `GEMINI_API_KEY` is not.
- `gpt-5.5` is a real model on the provided OpenAI account.
- The committed `.fusionkit/fusion.json` panel currently uses OpenRouter
  (`moonshotai/kimi-k2-thinking`, `qwen/qwen3-coder`) and requires
  `OPENROUTER_API_KEY`.

### Matter MCP (external research)

Handoffkit reads tagged Matter items through the `matter-cursor-mcp` npm package registered as an MCP server in the Cursor dashboard for cloud agents or via `.cursor/mcp.json` for desktop Cursor. There is no local build in this repo; see `docs/matter-mcp.md` for setup and cutover notes.

- Read `.matter-context.json` before calling Matter tools. Default tags: `cursor`, `repo-handoffkit`.
- Verify with `matter_health` before relying on Matter evidence.
- Write durable research to `docs/research/matter/` unless the user asks otherwise.
- If `matter_*` tools are absent from the MCP catalog, the MCP registration is missing; tell the user.

See `docs/matter-mcp.md` for setup and verification.
