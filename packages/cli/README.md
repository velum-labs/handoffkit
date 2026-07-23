# fusionkit

Real model fusion behind your coding agent. `fusionkit` spins up a panel of
models, has each produce a real candidate, and lets a judge synthesize the
answer your coding agent (Codex, Claude Code, or Cursor) actually runs — all from
one command.

```bash
npm install -g @fusionkit/cli
cd your-project        # a git repo
fusionkit init         # scaffold Fusion v4 + RouteKit config
fusionkit doctor       # check prerequisites
fusionkit codex        # launch Codex backed by the fusion panel
```

## Prerequisites

`fusionkit` orchestrates other tools, so a few things must be available:

- **[uv](https://docs.astral.sh/uv/getting-started/installation/)** — provides
  `uvx`, used to run the internal Python synthesis sidecar from the `fusionkit`
  PyPI distribution. No manual Python install is needed.
- **A coding agent on your PATH** — one of:
  [`codex`](https://github.com/openai/codex),
  [`claude`](https://docs.anthropic.com/en/docs/claude-code/overview), or
  [`cursor-agent`](https://cursor.com/cli), or
  [`opencode`](https://opencode.ai/).
- **A RouteKit router configuration** — `.routekit/router.yaml` explicitly
  enables providers. RouteKit discovers their models and advertises
  namespaced `provider/model` IDs. Export the registry-defined credential for
  every selected API provider or enroll the required subscription accounts.
  FusionKit does not read provider credentials or silently drop members whose
  credentials are missing.
- **A git repository** — the panel fuses over the code in your current repo.

Run `fusionkit doctor` any time to see exactly what is and isn't ready.

> The user-facing `fusionkit` executable belongs only to this npm package. The
> Python distribution is an internal runtime installed through `uvx` and
> exposes `fusionkit-sidecar`, not another `fusionkit` executable.
>
> - `fusionkit --version` — npm CLI version plus the pinned sidecar version
> - `fusionkit version` — full matrix (CLI, synthesizer, runners, agents, tool packages)

## Cost

An ensemble runs **multiple live RouteKit models plus judge/synthesis calls** on
every prompt, so usage adds up. When the coding agent exits, fusionkit prints a
session receipt with fused turns, gateway-observed spend, and the `--resume`
id. Choose namespaced provider/model IDs and validate the embedded project
catalog with `fusionkit doctor`; when `router.url` targets the standalone
singleton, inspect that external catalog with `routekit models list`. Set a
session cap with `--budget`.

## Per-repo config

Tired of long flag lines? Scaffold a committed `.fusionkit/` folder:

```bash
fusionkit init
```

It writes `.fusionkit/fusion.json` from the live namespaced model IDs discovered
for `.routekit/router.yaml`. The Fusion file owns ensembles,
judge/synthesizer choices, tool defaults, run policy, and prompt overrides; the
RouteKit file owns explicit providers and pooling policy. Inspect the effective
Fusion config with `fusionkit config show`.

## Local checkout development

Contributors can install a separate global `fusionkit-dev` command that always
runs their local checkout instead of the published npm package:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev:link-cli
fusionkit-dev --version
```

Run it from any project repo:

```bash
cd your-project
fusionkit-dev doctor
fusionkit-dev codex
```

The dev command rebuilds `packages/cli` before launch, preserves the caller's
working directory, and does not replace the normal `fusionkit` binary. Set
`FUSIONKIT_DEV_SKIP_BUILD=1` after a build when you want a faster local check.

## Commands

- `fusionkit codex | claude | cursor` — launch that agent backed by the panel.
- `fusionkit opencode` — launch OpenCode through the same neutral tool contract.
- `fusionkit serve` — just run the gateway and print setup snippets for any tool.
- `fusionkit stop` — stop Fusion-owned processes and portless routes.
- `fusionkit init` — scaffold the committed `.fusionkit/` folder for this repo.
- `fusionkit setup` — pre-provision the internal Python sidecar.
- `fusionkit doctor` — check prerequisites with fix hints.
- `fusionkit config show | path | get | set | unset | edit` — inspect or edit Fusion v4 policy.
- `fusionkit ensemble list | add | edit | remove | rename` — manage namespaced-model ensembles.
- `fusionkit prompts list | edit | reset` — manage judge/synthesizer prompt overrides.
- `fusionkit sessions list | show | rm` — manage durable Fusion sessions (`--resume` / `--continue` rehydrate them).
- `fusionkit models list | download | rm` — manage the local MLX model cache.
- `fusionkit version` — show versions for the CLI, synthesizer, runners, agents, and tool packages (`--json` for scripts).
- `fusionkit telemetry status | on | off | inspect` — control opt-in product telemetry.

Useful flags include `--ensemble`, `--observe`, `--budget`, `--repo`,
`--on-rate-limit`, `--resume`, and `--continue`. Provider/model/key flags and
`--direct` do not exist. For a single model, use a RouteKit launcher such as
`routekit codex openai/gpt-5.5`. Put global FusionKit options before the
subcommand, launch options after it, and `--` before arguments that must be
forwarded unchanged to the coding tool.

## Notes

- **Reasoning traces (default on):** while a fused turn runs, fusionkit narrates
  the process — "fusing across 3 models…", each member finishing, "judging 3
  candidates…" — directly in your coding agent's own thinking/reasoning UI
  (Codex reasoning summaries, Claude thinking, `reasoning_content` on the chat
  API). Disable with `--no-reasoning` or `"reasoning": false` in
  `.fusionkit/fusion.json`.
- `--observe` boots the Scope dashboard that streams live trace events.
  Published npm packages bundle its standalone server; `fusionkit-dev` builds
  and reuses the companion `apps/scope` source instead.
- `cursor` only needs a logged-in `cursor-agent` CLI; Cursorkit ships bundled
  with this package, so no separate checkout is required.

## Adding a new tool

Each coding tool is its own workspace package implementing a single
neutral `ToolIntegration`, so supporting a new tool is additive:

1. Create `packages/tool-<name>/` (copy `packages/tool-codex` as a template). It
   depends on `@velum-labs/routekit-tools` and `@velum-labs/routekit-harness-core`, never on a
   FusionKit package.
2. Export a `const <name>Tool: ToolIntegration` with:
   - `launch(ctx)` — serialize `ctx.spec` and boot the tool against
     `ctx.spec.gatewayUrl`.
   - `driver` — the one canonical `HarnessDriver` implementation for that tool.
   - `capabilities` — explicit cross-harness grades for streaming, tools,
     images, and reasoning controls.
3. Add it to `toolIntegrations` in
   [`packages/tool-registry/src/index.ts`](../tool-registry/src/index.ts).

That one canonical registry entry wires the tool into both CLIs, the Fusion
panel's generic driver adapter, capability reporting, and preflight. FusionKit
only composes the imported registry with `setToolDriverRegistry`.
