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

FusionKit does **not** include product telemetry, phone-home analytics, or a hosted control plane. The CLI and gateway do not report usage back to Velum Labs.

## Provider egress

Your code and prompts are sent to exactly the providers in the effective panel config for the command you run, plus any passthrough provider you explicitly select. Inspect that before a run with:

```bash
fusionkit config show
```

The committed config in this repository routes through OpenRouter (`provider: "openrouter"`) and requires `OPENROUTER_API_KEY`. OpenRouter is an aggregator, so requests sent from this checkout go to OpenRouter and then to the selected upstream models. In your own repository, run `fusionkit init` or edit `.fusionkit/fusion.json` to choose a different panel.

## Rate-limit failover

The default rate-limit policy is `onRateLimit: "fusion"`. If you use a passthrough model and that vendor returns a rate-limit, quota, or billing error, FusionKit re-sends the failed turn to the configured panel providers so the session can continue. Set `--on-rate-limit passthrough` or `--on-rate-limit fail` when you do not want that provider expansion.
