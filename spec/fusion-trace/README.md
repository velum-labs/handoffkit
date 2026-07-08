# fusion-trace semantic conventions

The fusion stack traces with **OpenTelemetry**. There is no custom wire format:
components emit real OTel spans over OTLP/HTTP traces and real OTel events
(log records with an `event_name`) over OTLP/HTTP logs, propagate context with
W3C `traceparent`/`baggage`, and are configured with standard `OTEL_*`
environment variables. What this directory owns is the **semantic
conventions** — the vocabulary those signals use.

[`registry.json`](registry.json) is the single source of truth for:

- **Span names** (`fusion.turn`, `fusion.candidate`, `fusion.judge`, GenAI
  `chat` spans, …) for real units of work, and **event names**
  (`fusion.candidate.step`, `fusion.judge.thinking`, …) for live
  point-in-time signals. Events ride the OTel logs signal and export
  immediately, so dashboards update before the enclosing span ends.
- **Attribute keys** and their types. Where the OTel GenAI semantic
  conventions already define an attribute (`gen_ai.provider.name`,
  `gen_ai.request.model`, `gen_ai.usage.*`), the registry uses it instead of a
  `fusion.*` invention — that is what makes fusion model calls render natively
  in GenAI-aware backends such as PostHog LLM analytics. `fusion.*` keys are
  reserved for concepts GenAI semconv has no word for (candidates, judge
  decisions, trajectories).
- A **sensitivity class per attribute**: `local` attributes (prompts, code,
  repo paths, outputs) never leave the machine through the product-telemetry
  pipeline; `exportable` attributes may. Redaction is enforced structurally at
  the sink boundary from this classification.

## Generated bindings

`node scripts/generate-trace-conventions.mjs` embeds the registry into:

- `packages/protocol/src/generated/trace-conventions.ts` (dependency-free
  constants re-exported by `@fusionkit/protocol`; the OTel-backed helpers live
  in `@fusionkit/tracing`)
- `python/fusionkit-core/src/fusionkit_core/_generated/trace_conventions.py`
  (used by `fusionkit_core.trace`)
- `apps/scope/lib/generated/trace-conventions.ts` (used by the scope
  collector)

`pnpm check` fails when any binding is stale.

## Trace shape

- A **session** is a trace. The gateway mints one trace id per session and
  parents every turn onto a virtual session root span context, so multi-turn
  sessions stay correlated without holding a long-lived span open.
- **Units of work** (turn, candidate, judge, model call, passthrough, run) are
  real spans carrying the terminal summary attributes.
- **Live signals** are OTel events: log records carrying an `event_name`,
  fusion attributes, and the trace/span ids of their owning unit. They export
  immediately on the logs signal, keeping the scope dashboard live while a
  unit is still running — without polluting trace waterfalls with
  zero-duration spans.
- Context crosses process boundaries via W3C `traceparent` (trace identity)
  and `baggage` (fusion correlation context: `fusion.candidate.id`,
  `fusion.trajectory.id`, `fusion.turn`).

## Sinks

- `apps/scope` ingests OTLP/HTTP JSON at `POST /api/ingest/v1/traces` (spans)
  and `POST /api/ingest/v1/logs` (events) and stores both natively in SQLite.
- Any OTel backend works via `OTEL_EXPORTER_OTLP_ENDPOINT` (or the
  signal-specific `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` /
  `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`) — e.g. PostHog distributed tracing
  (`https://us.i.posthog.com/i/v1/traces` with an `Authorization=Bearer
  <token>` header) or a local Jaeger.
- The CLI's opt-in product telemetry derives PostHog events from finished
  spans, copying only `exportable`-tagged attributes.
