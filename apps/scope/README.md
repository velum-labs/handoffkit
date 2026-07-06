# scope — fusion observability

A local dashboard for the fusion stack (FusionKit + HandoffKit + Cursorkit). It
collects `fusion-trace-event.v1` events into a local SQLite store and renders
sessions, panel-model trajectories, the judge's thinking-to-final flow, judge
decision stats (synthesize vs. select, per-model win rates), spend rollups,
per-model rollups, and environment snapshots — live, over an SSE stream.

`apps/scope` is a standalone pnpm workspace (not part of the root workspace).
All commands below run from this directory.

## Develop

```bash
pnpm install
pnpm dev          # portless → http://scope.localhost (proxies next dev on :4317)
pnpm dev:app      # plain next dev on http://127.0.0.1:4317
```

The UI is empty until events arrive. Seed demo data (succeeded, failed,
still-running, and judge-selects-verbatim sessions, including cost entries)
against the running dev server:

```bash
pnpm seed                                   # defaults to http://127.0.0.1:4317
pnpm seed --url http://127.0.0.1:4317       # explicit collector URL
```

For real data, run any FusionKit front door with observability on
(`fusionkit codex --observe`); the CLI boots this app and points the emitters
at it via `FUSION_TRACE_URL`.

## Test

```bash
pnpm test         # Node test runner: session derivation, collector, API round-trips
pnpm build        # next build (also type-checks)
```

## How data flows

- `POST /api/ingest` accepts a single event, an array, or `{ events: [...] }`
  and returns `{ accepted, rejected }`. Ingest is idempotent by content hash.
- `GET /api/stream` is the SSE feed of newly ingested events; every page
  live-refreshes off it.
- `POST /api/replay` backfills from `*.jsonl` files in `FUSION_TRACE_DIR`
  (or a `{ dir }` body) — also reachable via the Replay button on the
  sessions page.
- Storage is a single SQLite file at `SCOPEKIT_DB` (default
  `.scopekit/scope.db` under the working directory).

The event contract lives in `spec/fusion-trace/` at the repo root;
`lib/types.ts` mirrors it for the collector.

## Theming

Light, dark, and system themes are supported (toggle in the sidebar footer).
The choice persists in a `scope_theme` cookie so the server renders the right
theme without a flash. All data-viz colors (status, trace component,
trajectory step, JSON syntax) are semantic tokens in `app/globals.css` —
reference the tokens, never raw hex, when adding visuals.
