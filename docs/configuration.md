# Configuration

FusionKit has **one config source of truth**: a committed `.fusionkit/` folder at
your repo root. The Node `@fusionkit/cli` is the single front door; the Python
`fusionkit serve` is the documented raw endpoint, and the YAML it consumes is
*derived* from `.fusionkit/fusion.json` — never hand-maintained separately.

```
.fusionkit/
  fusion.json        # the only file you hand-edit (panel, judge, tool, run defaults)
  prompts/<id>.md    # optional system-prompt overrides (judge, synthesizer)
```

`.fusionkit/` is safe to commit: it stores only the *names* of the env vars that
hold API keys (`keyEnv`), never the secret values.

## Precedence

At run time, every setting resolves in this order (first wins):

```
explicit CLI flag   >   .fusionkit/fusion.json   >   built-in default
```

So `.fusionkit/fusion.json` is a default layer, not a lock — a flag like
`--local`, `--no-observe`, or `--model gpt=openai:gpt-5.5` always overrides the
file, and the file overrides the built-in defaults.

Inspect the merged result and where each value came from:

```bash
fusionkit config show        # effective config + provenance (flag / .fusionkit / default)
fusionkit config path        # the .fusionkit/fusion.json location
```

## The config model

`.fusionkit/fusion.json` (`version: "fusionkit.fusion.v2"`) fields:

| Field         | Meaning                                                            | Default |
|---------------|-------------------------------------------------------------------|---------|
| `tool`        | default coding agent (`codex` \| `claude` \| `cursor` \| `serve`) | `codex` |
| `panel`       | the panel members (`id`, `model`, `provider`, `keyEnv`/`auth`)    | the cloud trio (or local trio when `local`) |
| `judgeModel`  | the panel model used as judge/synthesizer (by model name)         | first panel member |
| `local`       | use the local MLX trio instead of the cloud panel                 | `false` |
| `observe`     | boot the observability dashboard by default                       | `false` |
| `onRateLimit` | vendor rate-limit/credit handoff: `fusion` \| `passthrough` \| `fail` | `fusion` |
| `portless`    | route services through portless stable URLs                       | `true`  |
| `port`        | fixed gateway port (else ephemeral)                               | ephemeral |
| `prompts`     | hydrated from `.fusionkit/prompts/*.md` (not stored inline)       | built-in |

### Default panels

When `panel` is unset, the default is hardware-shaped:

- **Cloud (default)** — a genuine decorrelated three-vendor trio:
  `gpt` (`openai:gpt-5.5`), `sonnet` (`anthropic:claude-sonnet-4-6`), and
  `gemini` (`google:gemini-2.5-pro`). Set `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
  and `GEMINI_API_KEY`. A member whose key is missing simply fails its slot; the
  survivors are still fused.
- **Local (`local: true` / `--local`)** — the MLX trio (Apple Silicon): Qwen3
  1.7B, Gemma 3 1B, and Llama 3.2 1B.

## The derived router YAML (raw `fusionkit serve`)

Most users never touch the Python YAML — the Node CLI generates it in-process for
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
live Node run — run those panels through `fusionkit <tool>` / `fusionkit serve`
via the CLI instead.)

## Scaffolding

`fusionkit init` walks you through building a panel and writes `.fusionkit/`. On a
non-interactive stdin (CI) it falls back to the default cloud trio so it still
produces a sensible config. `fusionkit doctor` checks prerequisites (uv, agents,
provider keys, git) and reports the repo's config status.
