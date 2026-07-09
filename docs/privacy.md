# Privacy and data handling

FusionKit is local-first orchestration, but it forwards your prompts and code to the model providers you configure. This page names what is stored, where code travels, and how to delete local state.

## Local files

By default, durable gateway sessions live under `~/.fusionkit/sessions/`:

- `turns.jsonl` stores each turn, including the full message arrays sent by the harness or client. Those messages can include source code, diffs, prompts, tool results, and pasted secrets.
- `meta.json` stores session metadata such as tool, repo, model ids, timestamps, resume state, and panel information.
- `costs.jsonl` stores per-turn token and USD estimates when pricing data is available.

Cloud-panel cost consent is stored in `~/.fusionkit/consent.json` by default.

## Retention and deletion

FusionKit keeps local session files until you remove them:

```bash
fusionkit sessions
fusionkit sessions rm <id>
```

Use `FUSIONKIT_SESSIONS_DIR` to move the durable session store, and `FUSIONKIT_CONSENT_PATH` to move the consent file.

## Telemetry

FusionKit sends **no telemetry unless you explicitly turn it on**, and has no hosted control plane. Anonymous usage telemetry (PostHog) is strictly opt-in: it is off by default, never enabled by an update, and `fusionkit init` asks at most once.

When enabled, exactly two event kinds are sent, built from a fixed allow-list — never prompts, code, diffs, file paths, repo names, or model outputs:

- `cli.command`: command name, CLI version, os/arch, node major version, coarse duration bucket, exit kind, boolean flag presence (`observe`, `local`), and whether the run was in CI.
- `fusion.session`: panel size, provider names (e.g. `openai`, `anthropic`, `mlx`), harness kind, judge decision (`synthesize` or `select_trajectory`), turn count, coarse duration bucket, token totals, and error kind.

Events are anonymous by design: the only identifier is a random install UUID minted when you opt in, and PostHog person profiles and client IP retention are disabled on every event (`$process_person_profile: false`, `$ip: null`).

Controls:

```bash
fusionkit telemetry status   # effective state, deciding layer, and the full field list
fusionkit telemetry on       # opt in (mints the anonymous install id)
fusionkit telemetry off      # opt out (deletes the install id)
fusionkit telemetry inspect  # print what would be sent, sending nothing
```

`DO_NOT_TRACK=1` and `FUSIONKIT_TELEMETRY=0` force telemetry off above any stored consent; consent lives in `~/.fusionkit/telemetry.json` (override with `FUSIONKIT_TELEMETRY_PATH`).

## Tracing

Fusion runs are instrumented with OpenTelemetry. By default nothing is exported: without an `OTEL_EXPORTER_OTLP_ENDPOINT` (or the signal-specific traces/logs variants) no exporter is installed and nothing leaves the process. `--observe` points the exporters at the local scope dashboard (loopback only). You may point them at any OTLP backend yourself — that is your egress choice, and span/event attributes classified `local` in `spec/fusion-trace/registry.json` (prompts, code, outputs, paths) are only ever consumed locally by the product's own pipelines.

## Provider egress

Your code and prompts are sent to exactly the providers in the effective panel config for the command you run, plus any passthrough provider you explicitly select. Inspect that before a run with:

```bash
fusionkit config show
```

The committed config in this repository routes through OpenRouter (`provider: "openrouter"`) and requires `OPENROUTER_API_KEY`. OpenRouter is an aggregator, so requests sent from this checkout go to OpenRouter and then to the selected upstream models. In your own repository, run `fusionkit init` or edit `.fusionkit/fusion.json` to choose a different panel.

## Rate-limit failover

The default rate-limit policy is `onRateLimit: "fusion"`. If you use a passthrough model and that vendor returns a rate-limit, quota, or billing error, FusionKit re-sends the failed turn to the configured panel providers so the session can continue. Set `--on-rate-limit passthrough` or `--on-rate-limit fail` when you do not want that provider expansion.
