# Quickstart: rate-limit / credit handoff

The headline feature: when a vendor passthrough model hits a **rate limit, quota,
or billing error**, the turn is transparently continued on the **ensemble**
instead of failing — and you're told it happened.

See also: [coding harness](quickstart-harness.md) ·
[inference endpoint](quickstart-inference.md) · [model catalog](model-catalog.md) ·
[CLI reference](cli.md) · [configuration](configuration.md).

## The idea

While you work directly against a single vendor model (a **passthrough** pick in
your agent's `/model` menu, or the `model` field of a raw request), that vendor
can throttle or run out of credit. Normally that's a hard `429` and a dead turn.
With FusionKit, the gateway **detects** the failure, **excludes** the throttled
vendor from the panel, and **re-runs the same turn on the ensemble** (which
already tolerates missing panel members). You get an answer instead of an error.

## How to use it

It's on by default. Just run a harness (or the endpoint) normally:

```bash
fusionkit codex                 # --on-rate-limit fusion is the default
```

Control the policy with `--on-rate-limit`:

| Policy | Behavior on a vendor rate-limit / credit error |
| --- | --- |
| `fusion` *(default)* | continue the turn on the ensemble (excluding the throttled vendor) |
| `passthrough` | return the vendor's error verbatim (no handoff) |
| `fail` | surface a clear gateway error |

```bash
fusionkit codex --on-rate-limit fusion        # transparent handoff (default)
fusionkit codex --on-rate-limit passthrough   # see the raw vendor error
fusionkit codex --on-rate-limit fail          # stop with a gateway error
```

Set it as a repo default via `onRateLimit` in
[`.fusionkit/fusion.json`](configuration.md).

## What you see on failover

When a handoff fires, the gateway logs a clear notice — the panel runs
**excluding** the rate-limited vendor — e.g.:

```
fusion: running panel (gpt, gemini) for session <id> (excluding sonnet after a vendor rate-limit)...
```

The agent receives a normal, complete answer in its native dialect; the only
visible difference is that the throttled vendor sat this turn out.

## Detection (what counts as a rate-limit)

The shared classifier maps upstream failures into three buckets:

- **transient** — `429`, `overloaded`, `Retry-After` → eligible for handoff;
- **quota-exhausted** — `insufficient_quota`, billing/credit errors → handoff;
- **auth-permanent** — `401`/`403`/model-not-found → *not* a rate-limit; surfaced
  as a real error (a handoff wouldn't help).

## One-tap resume

Because sessions are durable (persisted under `~/.fusionkit/sessions/`), you can
also pick a session back up later on the ensemble:

```bash
fusionkit sessions              # list sessions (id, tool, panel, turns, last activity, cost)
fusionkit codex --continue      # resume the most recent session
fusionkit codex --resume 1a2b3c # resume a specific session (unique prefix ok)
```

This is the cheap, robust complement to mid-stream cutover: if a turn ever does
fail outright, the same task continues on the ensemble with one command. See the
[CLI reference](cli.md#durable-sessions---resume----continue) for session
details and [`--budget`](cli.md#cost-metering-and-budgets---budget) for cost caps.
