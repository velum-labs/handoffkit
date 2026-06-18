import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { FusionTraceEvent, StoredEvent } from "./types";

/**
 * The collector store. A single local SQLite file (via Node's built-in
 * node:sqlite) holds every ingested trace event plus a lightweight derived
 * `sessions` row. An in-process EventEmitter fans newly ingested events out to
 * SSE subscribers for live updates. The whole thing is process-local, which is
 * exactly right for a single-command local dashboard.
 */

export type SessionRow = {
  trace_id: string;
  started_at: number;
  last_ts: number;
  status: string;
  dialect: string | null;
  repo: string | null;
  environment: string | null;
  final_output: string | null;
  event_count: number;
};

const globalForDb = globalThis as unknown as {
  __scopekitDb?: DatabaseSync;
  __scopekitBus?: EventEmitter;
};

function dbPath(): string {
  return process.env.SCOPEKIT_DB ?? join(process.cwd(), ".scopekit", "scope.db");
}

export function bus(): EventEmitter {
  if (globalForDb.__scopekitBus === undefined) {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(0);
    globalForDb.__scopekitBus = emitter;
  }
  return globalForDb.__scopekitBus;
}

export function db(): DatabaseSync {
  if (globalForDb.__scopekitDb !== undefined) return globalForDb.__scopekitDb;
  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });
  const handle = new DatabaseSync(path);
  handle.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT UNIQUE,
      trace_id TEXT NOT NULL,
      span_id TEXT NOT NULL,
      parent_span_id TEXT,
      seq INTEGER NOT NULL,
      ts REAL NOT NULL,
      component TEXT NOT NULL,
      event_type TEXT NOT NULL,
      candidate_id TEXT,
      model_id TEXT,
      payload TEXT
    );
    CREATE INDEX IF NOT EXISTS events_trace_idx ON events (trace_id, ts, id);
    CREATE TABLE IF NOT EXISTS sessions (
      trace_id TEXT PRIMARY KEY,
      started_at REAL NOT NULL,
      last_ts REAL NOT NULL,
      status TEXT NOT NULL,
      dialect TEXT,
      repo TEXT,
      environment TEXT,
      final_output TEXT
    );
  `);
  globalForDb.__scopekitDb = handle;
  return handle;
}

function eventHash(event: FusionTraceEvent): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        event.trace_id,
        event.span_id,
        event.component,
        event.event_type,
        event.seq,
        event.ts,
        event.payload ?? null
      ])
    )
    .digest("hex");
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Insert one event (idempotent by content hash) and update its session row. */
export function ingestEvent(event: FusionTraceEvent): boolean {
  const handle = db();
  const hash = eventHash(event);
  const insert = handle.prepare(
    `INSERT OR IGNORE INTO events
       (hash, trace_id, span_id, parent_span_id, seq, ts, component, event_type, candidate_id, model_id, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const result = insert.run(
    hash,
    event.trace_id,
    event.span_id,
    event.parent_span_id ?? null,
    event.seq,
    event.ts,
    event.component,
    event.event_type,
    event.candidate_id ?? null,
    event.model_id ?? null,
    event.payload !== undefined ? JSON.stringify(event.payload) : null
  );
  if (result.changes === 0) return false;
  updateSession(event);
  bus().emit("event", event);
  return true;
}

function updateSession(event: FusionTraceEvent): void {
  const handle = db();
  const payload = event.payload ?? {};
  handle
    .prepare(
      `INSERT INTO sessions (trace_id, started_at, last_ts, status)
       VALUES (?, ?, ?, 'running')
       ON CONFLICT(trace_id) DO UPDATE SET last_ts = max(last_ts, excluded.last_ts)`
    )
    .run(event.trace_id, event.ts, event.ts);

  if (event.event_type === "session.started") {
    const environment = (payload as { environment?: unknown }).environment;
    handle
      .prepare(
        `UPDATE sessions SET started_at = min(started_at, ?), dialect = ?, repo = ?, environment = ?
         WHERE trace_id = ?`
      )
      .run(
        event.ts,
        asString((payload as { dialect?: unknown }).dialect),
        asString((environment as { repo?: unknown } | undefined)?.repo),
        environment !== undefined ? JSON.stringify(environment) : null,
        event.trace_id
      );
  }

  if (event.event_type === "session.finished") {
    handle
      .prepare(`UPDATE sessions SET status = ?, final_output = coalesce(?, final_output) WHERE trace_id = ?`)
      .run(
        asString((payload as { status?: unknown }).status) ?? "succeeded",
        asString((payload as { final_output_preview?: unknown }).final_output_preview),
        event.trace_id
      );
  }

  if (event.event_type === "judge.final") {
    // In the judge-streamed-trajectory front door there is no single
    // session.finished (the harness simply stops calling); the judge's terminal
    // answer (judge.final) is the natural completion marker, so mark the session
    // succeeded and capture the final output unless an explicit finish set it.
    const record = (payload as { record?: { final_output?: unknown } }).record;
    const full = asString(record?.final_output) ?? asString((payload as { final_output?: unknown }).final_output);
    handle
      .prepare(
        `UPDATE sessions
         SET final_output = coalesce(?, final_output),
             status = CASE WHEN status = 'running' THEN 'succeeded' ELSE status END
         WHERE trace_id = ?`
      )
      .run(full, event.trace_id);
  }
}

export function listSessions(limit = 200): SessionRow[] {
  const handle = db();
  const rows = handle
    .prepare(
      `SELECT s.*, (SELECT count(*) FROM events e WHERE e.trace_id = s.trace_id) AS event_count
       FROM sessions s
       ORDER BY s.last_ts DESC
       LIMIT ?`
    )
    .all(limit) as unknown as SessionRow[];
  return rows;
}

export function getSession(traceId: string): SessionRow | undefined {
  const handle = db();
  const row = handle
    .prepare(
      `SELECT s.*, (SELECT count(*) FROM events e WHERE e.trace_id = s.trace_id) AS event_count
       FROM sessions s WHERE s.trace_id = ?`
    )
    .get(traceId) as unknown as SessionRow | undefined;
  return row;
}

function rowToEvent(row: Record<string, unknown>): StoredEvent {
  return {
    id: row.id as number,
    schema: "fusion-trace-event.v1",
    trace_id: row.trace_id as string,
    span_id: row.span_id as string,
    parent_span_id: (row.parent_span_id as string | null) ?? undefined,
    seq: row.seq as number,
    ts: row.ts as number,
    component: row.component as StoredEvent["component"],
    event_type: row.event_type as StoredEvent["event_type"],
    candidate_id: (row.candidate_id as string | null) ?? undefined,
    model_id: (row.model_id as string | null) ?? undefined,
    payload: typeof row.payload === "string" ? (JSON.parse(row.payload) as Record<string, unknown>) : undefined
  };
}

export function getEvents(traceId: string): StoredEvent[] {
  const handle = db();
  const rows = handle
    .prepare(`SELECT * FROM events WHERE trace_id = ? ORDER BY ts ASC, id ASC`)
    .all(traceId) as unknown as Array<Record<string, unknown>>;
  return rows.map(rowToEvent);
}

export function allEvents(limit = 5000): StoredEvent[] {
  const handle = db();
  const rows = handle
    .prepare(`SELECT * FROM events ORDER BY ts ASC, id ASC LIMIT ?`)
    .all(limit) as unknown as Array<Record<string, unknown>>;
  return rows.map(rowToEvent);
}

export function eventsByType(types: string[], limit = 20000): StoredEvent[] {
  if (types.length === 0) return [];
  const handle = db();
  const placeholders = types.map(() => "?").join(", ");
  const rows = handle
    .prepare(`SELECT * FROM events WHERE event_type IN (${placeholders}) ORDER BY ts ASC, id ASC LIMIT ?`)
    .all(...types, limit) as unknown as Array<Record<string, unknown>>;
  return rows.map(rowToEvent);
}
