# Quickstart: coding harness

Canonical user docs live at https://fusionkit.velum-labs.com/docs/getting-started/quickstart; this file is the in-repo mirror.


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
fusionkit init
$EDITOR .routekit/router.yaml
export PROVIDER_API_KEY=...      # the apiKeyEnv named by your endpoints
fusionkit doctor                 # verify uv, git, config, endpoints, and your agent CLI
```

Install the agent CLI you want to use (`codex`, `claude`, `cursor-agent`, or
`opencode`) before running `doctor`.

FusionKit composes live namespaced model IDs in `.fusionkit/fusion.json`; it does not
read provider credentials or skip unavailable panel members. Use
`routekit doctor`, `routekit providers status`, and `routekit models list` for
provider checks. This
repository's committed router uses OpenRouter and needs `OPENROUTER_API_KEY`.

## 2. Run it

```bash
cd your-git-repo
fusionkit codex                 # or: claude | cursor
```

That single command spawns everything and tears it all down on one `Ctrl+C`:

- an embedded or external **RouteKit router** that owns endpoint routing and
  provider egress;
- the internal **Python synthesis sidecar**, which receives completed
  trajectories and calls namespaced judge/synthesizer models through RouteKit;
- the **Node Fusion gateway**, translating to the agent's dialect (OpenAI Responses
  for Codex, Anthropic Messages for Claude Code, OpenAI Chat for Cursor); and
- the chosen **agent, pre-wired** to the gateway.

## What auto-wiring happens

You don't edit any agent config. `fusionkit` sets up each harness for you:

| Agent | How it is wired |
| --- | --- |
| Codex | an ephemeral `CODEX_HOME` with a `fusion-gateway` provider (`wire_api = responses`) |
| Claude Code | `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` pointed at the gateway |
| Cursor | the bundled cursorkit bridge driving `cursor-agent`; add `--ide` to wire the **Cursor IDE** through a local desktop proxy |
| OpenCode | the generic RouteKit tool launcher and driver |

```bash
fusionkit cursor --ide          # turnkey Cursor IDE (no manual tunnel)
```

## Picking a fused ensemble

The gateway advertises the default fused model (`fusion-panel`) and each named
ensemble as `fusion-<name>`. Use RouteKit for direct single-model sessions.

## Useful flags

`fusionkit`'s own flags go **before** the tool name; everything after is
forwarded to the agent.

```bash
fusionkit claude --repo /path/to/repo                     # fuse over another repo
fusionkit codex --ensemble review                         # configured namespaced-model ensemble
fusionkit codex --budget 5                                # stop at $5 of spend
fusionkit codex --continue                                # resume the last session
fusionkit codex --on-rate-limit fusion                    # handoff policy (default)
```

Full flag list: [CLI reference](cli.md). Make a repo's choices sticky with
`fusionkit init` and [`.fusionkit/`](configuration.md).
