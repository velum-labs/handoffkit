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
- **Provider API keys** for the default cloud panel: `OPENAI_API_KEY` and
  `ANTHROPIC_API_KEY` (exported, or in a project `.env` — fusionkit loads it
  automatically). Not needed for the local MLX panel (`--local`, Apple Silicon).
- **A git repository** — the panel fuses over the code in your current repo.

Run `fusionkit doctor` any time to see exactly what is and isn't ready.

> Two packages share the name "fusionkit": this npm CLI (`@fusionkit/cli`, the
> `fusionkit` command) and the Python distribution (`fusionkit` on PyPI) that
> provides the synthesizer. The CLI fetches the pinned PyPI build via `uvx`
> automatically; `fusionkit --version` prints both versions.

## Cost

The default panel runs **multiple frontier cloud models plus a judge** on every
prompt, so usage adds up. fusionkit asks for confirmation before starting a
cloud panel (skip with `--yes`). Use `--local` for the on-device MLX panel, or
`--model` to pick cheaper models.

## Per-repo config

Tired of long flag lines? Scaffold a committed `fusionkit.json`:

```bash
fusionkit fusion init
```

It records the panel, judge, default tool, and run defaults so the whole team
can just run `fusionkit codex`. Only env-var *names* for keys are stored, never
secrets. Explicit CLI flags always override the file. Inspect the effective
config and a dry-run preview with `fusionkit status`.

## Commands

- `fusionkit codex | claude | cursor` — launch that agent backed by the panel.
- `fusionkit serve` — just run the gateway and print setup snippets for any tool.
- `fusionkit fusion [tool]` — the generic launcher (interactive picker on a TTY).
- `fusionkit fusion init` — scaffold `fusionkit.json` for this repo.
- `fusionkit doctor` — check prerequisites with fix hints.
- `fusionkit status` — show the effective config and what a run will do.

Useful flags: `--local`, `--observe`, `--model ID=PROVIDER:MODEL`,
`--judge-model`, `--repo <dir>`, `--yes`. fusionkit's own flags must precede the
tool name; everything after the tool is forwarded to it.

## Notes

- `--observe` boots a local dashboard that streams live trace events. It is a
  separate app and is not bundled in the npm package; fusionkit prints how to
  enable it if it isn't available.
- `cursor` needs a built Cursorkit checkout (`--cursor-kit-dir` or
  `FUSIONKIT_CURSORKIT_DIR`); fusionkit prints setup guidance if it's missing.
