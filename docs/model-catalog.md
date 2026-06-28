# Model catalog & panel configuration

How to choose and configure the models in your ensemble panel — cloud providers,
any OpenAI-compatible / open-weight endpoint, and local MLX — plus pricing,
budgets, and the decorrelated-trio guidance.

See also: [coding harness](quickstart-harness.md) ·
[inference endpoint](quickstart-inference.md) · [rate-limit handoff](quickstart-handoff.md) ·
[CLI reference](cli.md) · [configuration](configuration.md).

## Panel providers

A panel is a list of members; each member has an `id`, a `model`, and a
`provider`:

| Provider | Use it for | Key env (default) |
| --- | --- | --- |
| `openai` | OpenAI models | `OPENAI_API_KEY` |
| `anthropic` | Anthropic models | `ANTHROPIC_API_KEY` |
| `google` | Google Gemini models | `GEMINI_API_KEY` |
| `openai-compatible` | Together / Fireworks / DeepInfra / self-hosted vLLM / any OpenAI-compatible endpoint (open-weight path) | per-endpoint (`--key-env`) |
| `mlx` | local models on Apple Silicon | none |

Add members on the command line (flags apply to every launcher and to
`fusionkit serve`):

```bash
# ID=PROVIDER:MODEL (repeatable). --models is an alias.
fusionkit codex \
  --model gpt=openai:gpt-5.5 \
  --model opus=anthropic:claude-opus-4-8 \
  --model gemini=google:gemini-2.5-pro

# A pre-running OpenAI-compatible endpoint as a panel member:
fusionkit codex --model-endpoint llama=http://127.0.0.1:8000

# A custom API-key env var for a member:
fusionkit codex --model deepinfra=openai-compatible:meta-llama/Llama-3.3-70B \
  --key-env deepinfra=DEEPINFRA_API_KEY
```

Pick who synthesizes with `--judge-model <model>` (defaults to the first panel
member). Persist any of this in [`.fusionkit/fusion.json`](configuration.md) via
`fusionkit init` so a repo always runs the same panel.

## The default cloud trio (decorrelated)

With no `--model` flags and no `--local`, the panel is a genuine **three-vendor
decorrelated trio** — three independent frontier voices rather than a single
cross-vendor pair:

| id | model | provider |
| --- | --- | --- |
| `gpt` | `gpt-5.5` | openai |
| `sonnet` | `claude-sonnet-4-6` | anthropic |
| `gemini` | `gemini-2.5-pro` | google |

It works cross-platform with `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and
`GEMINI_API_KEY` set. A member whose key is missing simply fails its slot;
survivors are still fused. **Decorrelation guidance:** prefer models from
*different* vendors/families so their errors are independent — that is what makes
fusion better than any single member.

## Local MLX (Apple Silicon)

Local models run on the MLX runtime, which is **Apple-Silicon-only**. Use the
local trio with `--local`, and manage the on-disk cache with `fusionkit models`:

```bash
fusionkit codex --local                          # local MLX trio
fusionkit models                                 # curated catalog + what's downloaded + RAM fit
fusionkit models download mlx-community/Qwen3-1.7B-4bit
fusionkit models rm mlx-community/Qwen3-1.7B-4bit
```

`fusionkit models list` shows each model's size, a conservative RAM floor, and
whether it fits this machine. On a non-Apple-Silicon host, `--local` fails early
with a pointer back to the cloud path (the Linux/NVIDIA vLLM/TGI backend is not
yet available). `fusionkit doctor` reports per-platform capability.

## Mixed panels

You can mix substrates — e.g. two cloud frontier models plus one local model:

```bash
fusionkit codex \
  --model gpt=openai:gpt-5.5 \
  --model sonnet=anthropic:claude-sonnet-4-6 \
  --model qwen=mlx:mlx-community/Qwen3-1.7B-4bit
```

(The local member still requires Apple Silicon.)

## Pricing, cost, and `--budget`

Every turn is metered (tokens + USD, from each endpoint's `pricing` metadata) and
a running session total is kept (`fusionkit sessions` shows it). Cap a session's
spend with `--budget <usd>`:

```bash
fusionkit codex --budget 5         # stop once gateway-observed spend crosses $5
```

A fused turn is priced against the configured **judge** model (the synthesis
call's usage); where a model has no pricing metadata the turn is reported
`unknown_cost`. Set `budgetUsd` as a repo default in
[`.fusionkit/fusion.json`](configuration.md). The default cloud panel prompts
once for cost confirmation before its first run (skip with `--yes`).

## Verifying your setup

```bash
fusionkit status                   # the effective panel, judge, and run plan
fusionkit config show              # merged config + where each value came from
fusionkit doctor                   # uv, git, agent CLIs, provider keys, platform capability
```
