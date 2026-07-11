import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { attrJson, attrStr } from "./types";
import type { AttributeSource, IncomingEvent, IncomingSpan, StoredEvent, StoredSpan } from "./types";

/**
 * The collector store: a single local SQLite file (via Node's built-in
 * node:sqlite) holding every ingested span and fusion event plus a
 * lightweight derived `sessions` row per trace. An in-process EventEmitter
 * fans newly ingested signals out to SSE subscribers for live updates.
 * Process-local by design — exactly right for a single-command local
 * dashboard.
 *
 * Trace data is disposable: the schema carries a version (PRAGMA
 * user_version) and the store recreates itself on mismatch. No migrations.
 */

const SCHEMA_VERSION = 3;

export type SessionRow = {
  trace_id: string;
  started_at: number;
  last_ts: number;
  status: string;
  dialect: string | null;
  repo: string | null;
  environment: string | null;
  prompt_preview: string | null;
  final_output: string | null;
  span_count: number;
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

function createSchema(handle: DatabaseSync): void {
  handle.exec(`
    CREATE TABLE IF NOT EXISTS spans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT NOT NULL,
      span_id TEXT NOT NULL,
      parent_span_id TEXT,
      name TEXT NOT NULL,
      component TEXT NOT NULL,
      service TEXT,
      start_ms REAL NOT NULL,
      end_ms REAL NOT NULL,
      status TEXT NOT NULL,
      status_message TEXT,
      attributes TEXT,
      UNIQUE(trace_id, span_id)
    );
    CREATE INDEX IF NOT EXISTS spans_trace_idx ON spans (trace_id, start_ms, id);
    CREATE INDEX IF NOT EXISTS spans_name_idx ON spans (name);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT NOT NULL,
      span_id TEXT,
      name TEXT NOT NULL,
      component TEXT NOT NULL,
      service TEXT,
      ts_ms REAL NOT NULL,
      attributes TEXT
    );
    CREATE INDEX IF NOT EXISTS events_trace_idx ON events (trace_id, ts_ms, id);
    CREATE INDEX IF NOT EXISTS events_name_idx ON events (name);
    CREATE TABLE IF NOT EXISTS sessions (
      trace_id TEXT PRIMARY KEY,
      started_at REAL NOT NULL,
      last_ts REAL NOT NULL,
      status TEXT NOT NULL,
      dialect TEXT,
      repo TEXT,
      environment TEXT,
      prompt_preview TEXT,
      final_output TEXT
    );
    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
}

export function db(): DatabaseSync {
  if (globalForDb.__scopekitDb !== undefined) return globalForDb.__scopekitDb;
  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });
  const handle = new DatabaseSync(path);
  handle.exec("PRAGMA journal_mode = WAL;");
  const versionRow = handle.prepare("PRAGMA user_version").get() as { user_version?: number };
  if ((versionRow.user_version ?? 0) !== SCHEMA_VERSION) {
    // A pre-cutover (or future) store: recreate. Trace data is disposable.
    handle.exec("DROP TABLE IF EXISTS spans; DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS sessions;");
  }
  createSchema(handle);
  globalForDb.__scopekitDb = handle;
  return handle;
}

function rowAttributes(row: Record<string, unknown>): Record<string, unknown> {
  if (typeof row.attributes === "string" && row.attributes.length > 0) {
    try {
      return JSON.parse(row.attributes) as Record<string, unknown>;
    } catch {
      // tolerate a corrupt row rather than failing the page
    }
  }
  return {};
}

function rowToSpan(row: Record<string, unknown>): StoredSpan {
  const attributes = rowAttributes(row);
  return {
    id: row.id as number,
    trace_id: row.trace_id as string,
    span_id: row.span_id as string,
    ...(row.parent_span_id !== null ? { parent_span_id: row.parent_span_id as string } : {}),
    name: row.name as string,
    component: row.component as string,
    ...(row.service !== null ? { service: row.service as string } : {}),
    start_ms: row.start_ms as number,
    end_ms: row.end_ms as number,
    status: row.status as StoredSpan["status"],
    ...(row.status_message !== null ? { status_message: row.status_message as string } : {}),
    attributes
  };
}

function rowToEvent(row: Record<string, unknown>): StoredEvent {
  return {
    id: row.id as number,
    trace_id: row.trace_id as string,
    ...(row.span_id !== null ? { span_id: row.span_id as string } : {}),
    name: row.name as string,
    component: row.component as string,
    ...(row.service !== null ? { service: row.service as string } : {}),
    ts_ms: row.ts_ms as number,
    attributes: rowAttributes(row)
  };
}

/**
 * Insert one span (idempotent per trace_id+span_id) and fold it into its
 * session row. Returns the stored span when newly inserted, undefined when it
 * was a duplicate.
 */
export function ingestSpan(span: IncomingSpan): StoredSpan | undefined {
  const handle = db();
  const insert = handle.prepare(
    `INSERT OR IGNORE INTO spans
       (trace_id, span_id, parent_span_id, name, component, service, start_ms, end_ms, status, status_message, attributes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const result = insert.run(
    span.trace_id,
    span.span_id,
    span.parent_span_id ?? null,
    span.name,
    span.component,
    span.service ?? null,
    span.start_ms,
    span.end_ms,
    span.status,
    span.status_message ?? null,
    JSON.stringify(span.attributes)
  );
  if (result.changes === 0) return undefined;
  const stored: StoredSpan = { ...span, id: Number(result.lastInsertRowid) };
  updateSession(stored);
  bus().emit("span", stored);
  return stored;
}

/**
 * Insert one fusion event and fold it into its session row (a turn-info
 * event carries the session identity; any event keeps the session's time
 * range fresh so live sessions appear before their first span finishes).
 */
export function ingestEvent(event: IncomingEvent): StoredEvent {
  const handle = db();
  const result = handle
    .prepare(
      `INSERT INTO events (trace_id, span_id, name, component, service, ts_ms, attributes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      event.trace_id,
      event.span_id ?? null,
      event.name,
      event.component,
      event.service ?? null,
      event.ts_ms,
      JSON.stringify(event.attributes)
    );
  const stored: StoredEvent = { ...event, id: Number(result.lastInsertRowid) };
  touchSession(event.trace_id, event.ts_ms, event.ts_ms);
  if (event.name === "fusion.turn.info") {
    applySessionIdentity(event.trace_id, event);
  }
  bus().emit("event", stored);
  return stored;
}

/** Touch (or create) a trace's session row with a newly seen time range. */
function touchSession(traceId: string, startMs: number, lastMs: number): void {
  db()
    .prepare(
      `INSERT INTO sessions (trace_id, started_at, last_ts, status)
       VALUES (?, ?, ?, 'running')
       ON CONFLICT(trace_id) DO UPDATE SET
         started_at = min(started_at, excluded.started_at),
         last_ts = max(last_ts, excluded.last_ts)`
    )
    .run(traceId, startMs, lastMs);
}

/**
 * Session identity: the turn-info event (or a run/passthrough span) carries
 * the dialect, environment snapshot, and prompt preview.
 */
function applySessionIdentity(traceId: string, source: AttributeSource): void {
  const environment = attrStr(source, "fusion.environment");
  const repo =
    attrStr(source, "fusion.repo") ?? attrJson<{ repo?: string }>(source, "fusion.environment")?.repo;
  db()
    .prepare(
      `UPDATE sessions SET
         dialect = coalesce(?, dialect),
         repo = coalesce(?, repo),
         environment = coalesce(?, environment),
         prompt_preview = coalesce(?, prompt_preview)
       WHERE trace_id = ?`
    )
    .run(
      attrStr(source, "fusion.dialect") ?? null,
      repo ?? null,
      environment ?? null,
      attrStr(source, "fusion.prompt_preview") ?? null,
      traceId
    );
}

/** Fold one ingested span into its trace's derived session row. */
function updateSession(span: StoredSpan): void {
  const handle = db();
  touchSession(span.trace_id, span.start_ms, span.end_ms);

  if (span.name === "fusion.run" || span.name === "fusion.passthrough") {
    applySessionIdentity(span.trace_id, span);
  }

  // Terminal signals: a run/passthrough span ends the session outright; a
  // judge span ending a fused turn marks the session succeeded (until a later
  // turn reopens it) and carries the fused output.
  if (span.name === "fusion.run" || span.name === "fusion.passthrough") {
    handle
      .prepare(
        `UPDATE sessions SET
           status = coalesce(?, status),
           final_output = coalesce(?, final_output)
         WHERE trace_id = ?`
      )
      .run(
        attrStr(span, "fusion.status") ?? null,
        attrStr(span, "fusion.final_output_preview") ?? null,
        span.trace_id
      );
  } else if (span.name === "fusion.judge" || span.name === "fusion.fuse") {
    // A terminal judge (or, for directly-driven fuse steps, fuse) span ends
    // the fused turn: carry the output and settle a running session.
    const finalOutput = attrStr(span, "fusion.final_output") ?? attrStr(span, "fusion.content");
    const terminal = span.name === "fusion.judge" || finalOutput !== undefined;
    handle
      .prepare(
        `UPDATE sessions SET
           final_output = coalesce(?, final_output),
           status = CASE WHEN status = 'running' AND ? IS NOT NULL THEN 'succeeded' ELSE status END
         WHERE trace_id = ?`
      )
      .run(finalOutput ?? null, span.status === "ok" && terminal ? 1 : null, span.trace_id);
  }
}

export function listSessions(limit = 200): SessionRow[] {
  const rows = db()
    .prepare(
      `SELECT s.*, (SELECT count(*) FROM spans p WHERE p.trace_id = s.trace_id) AS span_count
       FROM sessions s ORDER BY s.last_ts DESC LIMIT ?`
    )
    .all(limit) as unknown as SessionRow[];
  return rows;
}

export function getSession(traceId: string): SessionRow | undefined {
  const row = db()
    .prepare(
      `SELECT s.*, (SELECT count(*) FROM spans p WHERE p.trace_id = s.trace_id) AS span_count
       FROM sessions s WHERE s.trace_id = ?`
    )
    .get(traceId) as unknown as SessionRow | undefined;
  return row;
}

/** Every span of one trace, in start order (ingest id as tiebreak). */
export function getSpans(traceId: string): StoredSpan[] {
  const rows = db()
    .prepare("SELECT * FROM spans WHERE trace_id = ? ORDER BY start_ms ASC, id ASC")
    .all(traceId) as unknown as Record<string, unknown>[];
  return rows.map(rowToSpan);
}

/** Cross-session span scan by name (exact or prefix via `like`). */
export function spansByName(names: string[], limit = 20000): StoredSpan[] {
  if (names.length === 0) return [];
  const placeholders = names.map(() => "name = ? OR name LIKE ?").join(" OR ");
  const params = names.flatMap((name) => [name, `${name} %`]);
  const rows = db()
    .prepare(`SELECT * FROM spans WHERE ${placeholders} ORDER BY start_ms ASC, id ASC LIMIT ?`)
    .all(...params, limit) as unknown as Record<string, unknown>[];
  return rows.map(rowToSpan);
}

/** Every fusion event of one trace, in time order (ingest id as tiebreak). */
export function getEvents(traceId: string): StoredEvent[] {
  const rows = db()
    .prepare("SELECT * FROM events WHERE trace_id = ? ORDER BY ts_ms ASC, id ASC")
    .all(traceId) as unknown as Record<string, unknown>[];
  return rows.map(rowToEvent);
}

/** Cross-session event scan by exact name. */
export function eventsByName(names: string[], limit = 20000): StoredEvent[] {
  if (names.length === 0) return [];
  const placeholders = names.map(() => "?").join(", ");
  const rows = db()
    .prepare(`SELECT * FROM events WHERE name IN (${placeholders}) ORDER BY ts_ms ASC, id ASC LIMIT ?`)
    .all(...names, limit) as unknown as Record<string, unknown>[];
  return rows.map(rowToEvent);
}
