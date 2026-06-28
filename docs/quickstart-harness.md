# Quickstart: coding harness

Back an **unmodified coding agent** (Codex, Claude Code, Cursor) with a model
ensemble. The agent speaks its own native wire protocol to a local gateway and
never learns that fusion is happening.

See also: [inference endpoint](quickstart-inference.md) ·
[rate-limit handoff](quickstart-handoff.md) · [model catalog](model-catalog.md) ·
[CLI reference](cli.md) · [configuration](configuration.md).

## 1. Install + provision (one time)

```bash
pnpm add -g @fusionkit/cli      # or: npm i -g @fusionkit/cli
fusionkit setup                 # pre-provision the Python engine (warm the uv cache)
fusionkit doctor                # verify uv, git, your agent CLI, and provider keys
```

Install the agent CLI you want to use (`codex`, `claude`, or `cursor-agent`) and
export the provider keys for your panel:

```bash
export OPENAI_API_KEY=...  ANTHROPIC_API_KEY=...  GEMINI_API_KEY=...
```

## 2. Run it

```bash
cd your-git-repo
fusionkit codex                 # or: claude | cursor
```

That single command spawns everything and tears it all down on one `Ctrl+C`:

- the **model panel** (a decorrelated cloud trio by default — see the
  [model catalog](model-catalog.md));
- one **`fusionkit serve` router** that fronts each panel model and performs
  judge synthesis;
- the **harness gateway**, translating to the agent's dialect (OpenAI Responses
  for Codex, Anthropic Messages for Claude Code, OpenAI Chat for Cursor); and
- the chosen **agent, pre-wired** to the gateway.

## What auto-wiring happens

You don't edit any agent config. `fusionkit` sets up each harness for you:

| Agent | How it is wired |
| --- | --- |
| Codex | an ephemeral `CODEX_HOME` with a `fusion-gateway` provider (`wire_api = responses`) |
| Claude Code | `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` pointed at the gateway |
| Cursor | the bundled cursorkit bridge driving `cursor-agent`; add `--ide` to wire the **Cursor IDE** through a local desktop proxy (no public tunnel) |

```bash
fusionkit cursor --ide          # turnkey Cursor IDE (no manual tunnel)
```

## Picking the fused vs. passthrough model

The gateway advertises the **fused** model (`fusion-panel`) *and* each panel
member as a direct **passthrough**. Use the agent's own `/model` picker to switch
between "run the ensemble" and "use this one vendor directly" mid-session. When a
passthrough vendor hits a rate limit, the turn is transparently handed off to the
ensemble — see [rate-limit handoff](quickstart-handoff.md).

## Useful flags

`fusionkit`'s own flags go **before** the tool name; everything after is
forwarded to the agent.

```bash
fusionkit codex --local                                   # Apple-Silicon MLX trio
fusionkit claude --repo /path/to/repo                     # fuse over another repo
fusionkit codex --model gpt=openai:gpt-5.5 --model opus=anthropic:claude-opus-4-8
fusionkit codex --judge-model claude-sonnet-4-6           # who synthesizes
fusionkit codex --budget 5                                # stop at $5 of spend
fusionkit codex --continue                                # resume the last session
fusionkit codex --on-rate-limit fusion                    # handoff policy (default)
```

Full flag list: [CLI reference](cli.md). Make a repo's choices sticky with
`fusionkit init` and [`.fusionkit/`](configuration.md).
