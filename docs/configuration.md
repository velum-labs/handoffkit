# Configuration

FusionKit has **one config source of truth**: a committed `.fusionkit/` folder at
your repo root. The Node `@fusionkit/cli` is the single front door; the Python
`fusionkit serve` is the documented raw endpoint, and the YAML it consumes is
*derived* from `.fusionkit/fusion.json`. Never hand-maintain it separately.

```
.fusionkit/
  fusion.json               # all settings (ensembles, tool, run defaults) — managed by the CLI
  prompts/<id>.md           # default-ensemble system-prompt overrides (judge, synthesizer)
  prompts/<ensemble>/<id>.md # per-ensemble overrides (fall back to the flat files per id)
```

`.fusionkit/` is safe to commit: it stores only the *names* of the env vars that
hold API keys (`keyEnv`), never the secret values.

Everything is configurable from the CLI — `fusionkit config set/unset/edit`,
`fusionkit ensemble add/edit/remove/rename/use`, `fusionkit prompts edit/reset` —
and every mutation is validated by the same parser the runtime uses before it is
written. Hand-editing `fusion.json` still works; the CLI is just the better way.

## Precedence

At run time, every setting resolves in this order (first wins):

```
explicit CLI flag   >   .fusionkit/fusion.json   >   built-in default
```

So `.fusionkit/fusion.json` is a default layer, not a lock. A flag like
`--local`, `--no-observe`, or `--model gpt=openai:gpt-5.5` always overrides the
file, and the file overrides the built-in defaults.

Inspect and edit the merged result from the CLI:

```bash
fusionkit config show        # effective config + provenance (flag / .fusionkit / default)
fusionkit config get budgetUsd
fusionkit config set budgetUsd 5              # dot paths, validated before writing
fusionkit config set ensembles.deep.judgeModel claude-opus-4-8
fusionkit config unset budgetUsd              # the built-in default applies again
fusionkit config edit                         # interactive editor over every setting
fusionkit config path        # the .fusionkit/fusion.json location
```

All of it supports `--json` for scripting (`fusionkit config show --json`
includes per-field provenance).

## The config model

`.fusionkit/fusion.json` (`version: "fusionkit.fusion.v3"`) fields:

| Field             | Meaning                                                            | Default |
|-------------------|-------------------------------------------------------------------|---------|
| `tool`            | default coding agent (`codex` \| `claude` \| `cursor` \| `serve`) | `codex` |
| `ensembles`       | named ensembles, each with its own `panel`, `judgeModel`, `synthesizerModel` | one `default` ensemble (the cloud trio, or local trio when `local`) |
| `defaultEnsemble` | which ensemble a session defaults to                               | `default`, else the first |
| `local`           | use the local MLX trio instead of the cloud panel                  | `false` |
| `observe`         | boot the observability dashboard by default                        | `false` |
| `onRateLimit`     | vendor rate-limit/credit handoff: `fusion` \| `passthrough` \| `fail` | `fusion` |
| `budgetUsd`       | optional session spend cap in gateway-observed USD                 | unset |
| `subagents`       | auto-provision one native sub-agent per ensemble in the launched tool | `true` |
| `portless`        | route services through portless stable URLs                        | `true`  |
| `port`            | fixed gateway port (else ephemeral)                                | ephemeral |
| prompts           | hydrated from `.fusionkit/prompts/` (never stored inline)          | built-in |

Each ensemble entry:

| Field              | Meaning                                                             | Default |
|--------------------|---------------------------------------------------------------------|---------|
| `panel`            | the panel members (`id`, `model`, `provider`, `keyEnv`/`auth`)      | required (the `default` ensemble may omit it → built-in trio) |
| `judgeModel`       | the member used as judge (by member id or model name)               | first panel member |
| `synthesizerModel` | the member used as synthesizer (by member id or model name)         | the judge |

A single-ensemble config may still use the flat `panel`/`judgeModel` shorthand
(and every `v1`/`v2` file keeps loading): it upgrades in memory into
`ensembles.default`.

### Multiple named ensembles

Every ensemble is registered as its **own selectable model** in the launched
tool — `fusion-<name>`, with the `default` ensemble keeping the canonical
`fusion-panel` id — so you can point a session, a picker choice, or a sub-agent
at any ensemble. Manage them from the CLI:

```bash
fusionkit ensemble list                       # every ensemble + default marker
fusionkit ensemble add deep                   # interactive panel builder on a TTY, or:
fusionkit ensemble add deep --model opus=anthropic:claude-opus-4-8 \
  --model gpt=openai:gpt-5.5 --judge claude-opus-4-8
fusionkit ensemble edit deep --synthesizer claude-opus-4-8
fusionkit ensemble use deep                   # sessions default to it (defaultEnsemble)
fusionkit ensemble rename deep review         # per-ensemble prompts move with it
fusionkit ensemble remove review
```

The resulting file looks like:

```json
{
  "version": "fusionkit.fusion.v3",
  "tool": "codex",
  "defaultEnsemble": "default",
  "ensembles": {
    "default": {
      "panel": [
        { "id": "gpt", "model": "gpt-5.5", "provider": "openai", "keyEnv": "OPENAI_API_KEY" },
        { "id": "sonnet", "model": "claude-sonnet-4-6", "provider": "anthropic", "keyEnv": "ANTHROPIC_API_KEY" }
      ],
      "judgeModel": "gpt-5.5"
    },
    "deep": {
      "panel": [
        { "id": "opus", "model": "claude-opus-4-8", "provider": "anthropic", "keyEnv": "ANTHROPIC_API_KEY" },
        { "id": "gpt", "model": "gpt-5.5", "provider": "openai", "keyEnv": "OPENAI_API_KEY" }
      ],
      "judgeModel": "claude-opus-4-8",
      "synthesizerModel": "claude-opus-4-8"
    }
  }
}
```

Notes:

- A member `id` shared by two ensembles must be the *identical* spec — each id
  is one router endpoint. Give variants distinct ids.
- One stack serves every ensemble: the router fronts the union of members, and
  each fused request runs only its ensemble's panel with its judge/synthesizer
  and prompts.
- `fusionkit <tool> --ensemble deep` makes `deep` the session default; all
  ensembles are registered regardless. `--model`/`--judge-model` flags override
  the *selected* ensemble only.
- An ensemble other than the selected one whose members lack keys is skipped
  with a warning (keyless members are dropped per ensemble) instead of failing
  the launch.

### Sub-agents on a specific ensemble (out of the box)

Every launch auto-provisions **one native sub-agent per ensemble** in the
launched tool, so "spawn a sub-agent on the deep ensemble" works with zero
setup. Disable it all with `--no-subagents` (or `subagents: false` in
`fusion.json`).

- **Codex** — the ephemeral `CODEX_HOME` pins `[features] multi_agent = true`
  and defines one `[agents.fusion-<name>]` role per ensemble (role config pins
  `model = "fusion-<name>"`), so the model can `spawn_agent` on any ensemble
  and `codex --profile fusion-deep` still works for whole sessions. Roles are
  session-scoped; nothing touches `~/.codex`. If Codex rejects the generated
  catalog or roles at startup (schema drift), the launcher retries without
  them — fusion always still works.
- **Claude Code** — the launcher passes a session-scoped `--agents` JSON with
  one agent per ensemble (`model: claude-fusion-<name>`; Claude requires the
  `claude` prefix and the gateway maps it back). Ask Claude to "use the
  fusion-deep agent", or pass your own `--agents` — a user-supplied flag always
  wins. Committed `.claude/agents/*.md` files keep working as before.
- **Cursor** — Cursor only reads agent files from the repo, so the launcher
  scaffolds `.cursor/agents/fusion-<name>.md` per ensemble (never overwriting
  an existing file — edit and commit them to keep). Requires a recent
  `cursor-agent`; older CLI versions have known Task-tool delegation bugs.
- **opencode** — the ephemeral `opencode.json` defines one `subagent`-mode
  agent per ensemble (invoke via the Task tool or `@fusion-<name>` mentions).

The plain model ids also keep working everywhere: `codex --profile
fusion-deep`, Claude's `/model` picker (`claude-fusion-deep`),
`cursor-agent --model fusion-deep`, and opencode's picker.

**Typed tools pass through the gateway losslessly.** Some front-door tools are
declared by `type` instead of a name (Codex's `tool_search`, the door to its
deferred multi-agent tools) — the gateway projects every *client-executed*
typed tool to the fused model under its type as the function name, and emits
the model's calls back as the tool's native item (`tool_search_call`), which is
the shape the CLI dispatches. Server-executed tools (`web_search`, Anthropic's
`web_search_*`/`code_execution_*`) are excluded from the fused turn since
nothing behind the gateway can run them.

For Codex specifically this means fused-turn spawning works through its
**tool-discovery loop**: `spawn_agent` & co. are deferred, so the synthesizer
first calls `tool_search` (one extra fused turn — candidates stay cached), the
CLI executes the search client-side, and the gateway then advertises the
discovered tools (with their namespace, which Codex's dispatch requires) on the
follow-up turn, where the synthesizer calls `spawn_agent` on any
`fusion-<name>` role.

**Panel members** (the headless harnesses producing candidates) can spawn
sub-agents too — on their own model *or on any fused ensemble*:

- A Codex member's ephemeral home carries the multi-agent feature pin (depth 1,
  at most 3 threads) and a model catalog listing its own model **plus every
  `fusion-<name>` id**, so `spawn_agent(model: "fusion-kimi")` validates. The
  member's capture gateway routes those fused requests to the front-door
  fusion gateway; its own-model traffic keeps hitting its router endpoint.
- A router-gateway Claude member gets one session-scoped `--agents` definition
  per ensemble (same as the launcher), and its translation gateway routes the
  `claude-fusion-*` agent models to the front door. Native-Anthropic members
  (running directly against api.anthropic.com) stay same-model.

Fused delegation is **one level deep by design**: a member's fused turn reaches
the front door stamped with a panel-depth header, and the panel it fans out
gets no fused access of its own (its members are same-model only) — so a
misbehaving model can never recurse panels into a fork bomb. `--no-subagents` /
`subagents: false` disables all of it.

### Default panels

When `panel` is unset, the default is hardware-shaped:

- **Cloud (default)**: a genuine decorrelated three-vendor trio:
  `gpt` (`openai:gpt-5.5`), `sonnet` (`anthropic:claude-sonnet-4-6`), and
  `gemini` (`google:gemini-2.5-pro`). Set `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
  and `GEMINI_API_KEY`. A member whose key is missing simply fails its slot; the
  survivors are still fused.
- **Local (`local: true` / `--local`)**: the MLX trio (Apple Silicon): Qwen3
  1.7B, Gemma 3 1B, and Llama 3.2 1B.

## Web search (gateway-executed)

Codex and Claude Code both declare a *server-executed* web search tool
(`web_search` on the Responses API, `web_search_20250305` on the Anthropic
API). On the real provider APIs the backend runs the search mid-turn; behind
FusionKit the gateway plays that role: it projects the tool to the fused
panel, and when the fused model calls it, the gateway executes the search by
delegating to a real provider's native web search, feeds the results back,
and continues the turn. The caller sees native search items in its own
dialect, exactly as if it were talking to the provider directly.

Each dialect prefers its own provider — Codex searches via OpenAI, Claude
Code via Anthropic — and falls back to the other when only one key is set.
With neither key, the tool is dropped with the usual honest-drop warning.

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `FUSIONKIT_WEB_SEARCH` | on | Set to `0` to disable gateway web search entirely. |
| `FUSIONKIT_WEB_SEARCH_OPENAI_MODEL` | `gpt-5.5` | Model used for OpenAI-delegated searches. |
| `FUSIONKIT_WEB_SEARCH_ANTHROPIC_MODEL` | `claude-haiku-4-5` | Model used for Anthropic-delegated searches. |
| `FUSIONKIT_WEB_SEARCH_OPENAI_URL` | `https://api.openai.com/v1` | Base URL for the OpenAI search side call. |
| `FUSIONKIT_WEB_SEARCH_ANTHROPIC_URL` | `https://api.anthropic.com/v1` | Base URL for the Anthropic search side call. |

Searches are capped at 8 per caller turn and 90 seconds each; a failed search
becomes an error tool result the model can react to, never a failed turn.
`fusionkit doctor` reports which provider serves each dialect.

## The derived router YAML (raw `fusionkit serve`)

Most users never touch the Python YAML. The Node CLI generates it in-process for
every run. If you want to run the raw `fusionkit serve` endpoint directly, emit
the derived config:

```bash
fusionkit config export-yaml                 # print the derived YAML to stdout
fusionkit config export-yaml -o router.yaml  # write it to a file
fusionkit serve --config router.yaml         # run the raw endpoint with it
```

`export-yaml` reuses the exact generator the live stack writes, so the exported
file can never drift from what a real run produces. (Local MLX members carry an
empty `base_url` placeholder, since their loopback gateway only exists during a
live Node run. Run those panels through `fusionkit <tool>` / `fusionkit serve`
via the CLI instead.)

## Prompt overrides

The judge/synthesizer system prompts are committable `.md` files, managed from
the CLI:

```bash
fusionkit prompts list                        # which overrides exist, default and per-ensemble
fusionkit prompts edit judge                  # opens $EDITOR, seeded from the engine's default
fusionkit prompts edit judge --ensemble deep  # per-ensemble override
fusionkit prompts reset judge                 # back to the built-in default
```

An empty or absent file falls back to the built-in default at run time.

## Scaffolding

`fusionkit init` walks you through building a panel (live model lists,
hardware-aware local picks), the judge, the first ensemble's name (editable,
defaulting to `default` — which keeps the canonical `fusion-panel` model id;
any other name serves as `fusion-<name>` and becomes `defaultEnsemble`),
optional extras (budget, rate-limit policy, panel sandbox, reasoning), and
further named ensembles, then writes `.fusionkit/`. On a non-interactive stdin
(CI) it falls back to the default cloud trio so it still produces a sensible
config. `fusionkit doctor` checks
prerequisites (uv, agents, provider keys, git) and reports the repo's config
status.
