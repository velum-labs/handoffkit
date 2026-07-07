# scope — fusion observability

A local dashboard for the fusion stack (FusionKit + HandoffKit + Cursorkit). It
is a native **OTLP signal store**: components export OpenTelemetry spans (unit
work, on the traces signal) and fusion events (live point-in-time signals, on
the logs signal) to it over OTLP/HTTP, and it renders sessions, panel-model
trajectories, the judge's thinking-to-final flow, judge decision stats
(synthesize vs. select, per-model win rates), spend rollups, per-model rollups,
and environment snapshots — live, over an SSE stream.

`apps/scope` is a standalone pnpm workspace (not part of the root workspace).
All commands below run from this directory.

## Develop

```bash
pnpm install
pnpm dev          # portless → http://scope.localhost (proxies next dev on :4317)
pnpm dev:app      # plain next dev on http://127.0.0.1:4317
```

The UI is empty until signals arrive. Seed demo data (succeeded, failed,
still-running, and judge-selects-verbatim sessions, including cost entries)
against the running dev server:

```bash
pnpm seed                                   # defaults to http://127.0.0.1:4317
pnpm seed --url http://127.0.0.1:4317       # explicit collector URL
```

For real data, run any FusionKit front door with observability on
(`fusionkit codex --observe`); the CLI boots this app and exports
`OTEL_EXPORTER_OTLP_ENDPOINT=<scope>/api/ingest` into every spawned process
(the standard exporters append `/v1/traces` and `/v1/logs`).

## Test

```bash
pnpm test         # Node test runner: session derivation, collector, API round-trips
pnpm build        # next build (also type-checks)
```

## How data flows

- `POST /api/ingest/v1/traces` is a standard OTLP/HTTP traces endpoint: it
  accepts `ExportTraceServiceRequest` as JSON — so any OTel SDK can export to
  it — and returns the standard `{ partialSuccess: {} }`. Ingest is idempotent
  by span id.
- `POST /api/ingest/v1/logs` is the matching OTLP/HTTP logs endpoint: fusion
  events arrive as `ExportLogsServiceRequest` log records carrying `eventName`
  plus trace/span correlation.
- `GET /api/stream` is the SSE feed of newly ingested signals, tagged
  `kind: "span" | "event"`; every page live-refreshes off it.
- Storage is a single SQLite file at `SCOPEKIT_DB` (default
  `.scopekit/scope.db` under the working directory).

Span, event, and attribute names follow the fusion semantic conventions in
`spec/fusion-trace/registry.json` at the repo root; `lib/generated/` holds the
generated bindings and `lib/types.ts` the store's signal model. Sessions group
by trace id; events (`fusion.candidate.step`, `fusion.judge.thinking`,
`fusion.cost`, ...) carry live progress, and unit spans (`fusion.candidate`,
`chat`, `fusion.judge`) carry timing.

## Theming

Light, dark, and system themes are supported (toggle in the sidebar footer).
The choice persists in a `scope_theme` cookie so the server renders the right
theme without a flash. All data-viz colors (status, trace component,
trajectory step, JSON syntax) are semantic tokens in `app/globals.css` —
reference the tokens, never raw hex, when adding visuals.
