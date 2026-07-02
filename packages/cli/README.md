# fusionkit

Real model fusion behind your coding agent. `fusionkit` spins up a panel of
models, has each produce a real candidate, and lets a judge synthesize the
answer your coding agent (Codex, Claude Code, or Cursor) actually runs — all from
one command.

```bash
npm install -g @fusionkit/cli
cd your-project        # a git repo
fusionkit doctor       # check prerequisites
fusionkit codex        # launch Codex backed by the fusion panel
```

## Prerequisites

`fusionkit` orchestrates other tools, so a few things must be available:

- **[uv](https://docs.astral.sh/uv/getting-started/installation/)** — provides
  `uvx`, used to run the Python synthesizer (`fusionkit` on PyPI). No manual
  Python install needed.
- **A coding agent on your PATH** — one of:
  [`codex`](https://github.com/openai/codex),
  [`claude`](https://docs.anthropic.com/en/docs/claude-code/overview), or
  [`cursor-agent`](https://cursor.com/cli).
- **Provider API keys** for the default cloud panel (a three-vendor trio):
  `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `GEMINI_API_KEY` (exported, or in a
  project `.env` — fusionkit loads it automatically). Any subset works: a
  default-panel member whose key is missing is skipped with an explicit note,
  and the survivors are still fused. Not needed for the local MLX panel
  (`--local`, Apple Silicon).
- **A git repository** — the panel fuses over the code in your current repo.

Run `fusionkit doctor` any time to see exactly what is and isn't ready.

> Two packages share the name "fusionkit": this npm CLI (`@fusionkit/cli`, the
> `fusionkit` command) and the Python distribution (`fusionkit` on PyPI) that
> provides the synthesizer. The CLI fetches the pinned PyPI build via `uvx`
> automatically.
>
> - `fusionkit --version` — npm CLI version plus the pinned synthesizer version
> - `uvx fusionkit --version` — PyPI synthesizer version only
> - `fusionkit version` — full matrix (CLI, synthesizer, runners, agents, tool packages)

## Cost

The default panel runs **multiple frontier cloud models plus a judge** on every
prompt, so usage adds up. fusionkit asks for confirmation before starting a
cloud panel — once per repo+panel (the approval is remembered under
`~/.fusionkit/consent.json`; skip entirely with `--yes`). When the coding agent
exits, fusionkit prints a session receipt: fused turns, gateway-observed spend,
and the `--resume` id. Use `--local` for the on-device MLX panel, or `--model`
to pick cheaper models.

## Per-repo config

Tired of long flag lines? Scaffold a committed `.fusionkit/` folder:

```bash
fusionkit init
```

It writes `.fusionkit/fusion.json` (the panel, judge, default tool, and run
defaults) plus editable system-prompt overrides in `.fusionkit/prompts/*.md`, so
the whole team can just run `fusionkit codex`. Only env-var *names* for keys are
stored, never secrets. Explicit CLI flags always override the folder. A legacy
`fusionkit.json` is auto-migrated on first run. Inspect the effective config and
a dry-run preview with `fusionkit status`.

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
- `fusionkit serve` — just run the gateway and print setup snippets for any tool.
- `fusionkit fusion [tool]` — the generic launcher (interactive picker on a TTY).
- `fusionkit fusion stop` — reap portless singleton services (router, dashboard) left running by prior runs.
- `fusionkit init` — scaffold the committed `.fusionkit/` folder for this repo.
- `fusionkit setup` — pre-provision the Python fusion engine so the first run is instant.
- `fusionkit doctor` — check prerequisites with fix hints (`--provision` warms the engine too).
- `fusionkit status` — show the effective config and what a run will do.
- `fusionkit config show | path | export-yaml` — inspect the one config source of truth.
- `fusionkit sessions [show|rm]` — list, inspect, and remove durable gateway sessions (`--resume` / `--continue` rehydrate them).
- `fusionkit models list | download | rm` — manage the local MLX model cache.
- `fusionkit local <tool>` — back an agent with a single local model instead of the panel.
- `fusionkit version` — show versions for the CLI, synthesizer, runners, agents, and tool packages (`--json` for scripts).

Useful flags: `--local`, `--observe`, `--model ID=PROVIDER:MODEL`,
`--judge-model`, `--repo <dir>`, `--yes`. fusionkit's own flags must precede the
tool name; everything after the tool is forwarded to it.

## Notes

- **Reasoning traces (default on):** while a fused turn runs, fusionkit narrates
  the process — "fusing across 3 models…", each member finishing, "judging 3
  candidates…" — directly in your coding agent's own thinking/reasoning UI
  (Codex reasoning summaries, Claude thinking, `reasoning_content` on the chat
  API). Disable with `--no-reasoning` or `"reasoning": false` in
  `.fusionkit/fusion.json`.
- **Local narration model (opt-in):** `--reasoning-model` (or `"reasoningModel"`
  in `.fusionkit/fusion.json`) has a small local MLX model write the narration
  prose — one-sentence gists of what each candidate did and a comparison line at
  judge time — instead of the built-in templates. Bare flag uses
  `mlx-community/Qwen3-1.7B-4bit` (~1 GB, the smallest model that reliably
  handled both tasks in our benchmark; smaller models fabricated comparisons).
  Apple Silicon only; zero API spend; guardrails always apply (400ms budget,
  sanitization, template fallback), so a slow or weak model can only ever make
  a line plainer, never wrong.
- `--observe` boots a local dashboard that streams live trace events. It is a
  separate app and is not bundled in the npm package; fusionkit prints how to
  enable it if it isn't available.
- `cursor` only needs a logged-in `cursor-agent` CLI; Cursorkit ships bundled
  with this package, so no separate checkout is required.

## Adding a new tool

Each coding tool is its own workspace package implementing a single
`ToolIntegration` (the adapter), so supporting a new tool is additive:

1. Create `packages/tool-<name>/` (copy `packages/tool-codex` as a template). It
   depends on `@fusionkit/tools` for the `ToolIntegration` / `ToolLaunchContext`
   contract, and on `@fusionkit/ensemble` if it also ships a harness adapter.
2. Export a `const <name>Tool: ToolIntegration` with:
   - `launch(ctx)` — boot the tool's binary against `ctx.gatewayUrl` (the host
     injects `spawnTool`, portless, teardown, etc. via the context; tool packages
     never import the CLI).
   - `modes` — `"fusion"`, `"local"`, or both.
   - `createHarness` + `harnessKinds` — optional, only if the tool also runs as
     an ensemble harness in the gateway/e2e matrix.
3. Register it in [`packages/cli/src/tools.ts`](src/tools.ts) by adding it to the
   `createToolRegistry([...])` list.

That single registry entry wires the tool into the `fusionkit <tool>` launcher,
`fusionkit local <tool>`, the interactive picker, preflight, and (when it has a
harness) the ensemble gateway — no other switch statements to update.
