import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { sha256Hex } from "@warrant/protocol";
import type { ChainedEvent, Receipt, RunStatus } from "@warrant/protocol";

import { isPrincipalRole } from "./store.js";
import type {
  EnrollTokenRecord,
  PlaneStore,
  PrincipalRecord,
  RunRecord,
  RunnerRecord
} from "./store.js";

/**
 * node:sqlite-backed control-plane store. Single-file database with WAL
 * journaling and immediate-transaction claims. Synchronous by design
 * (DatabaseSync), which on a single plane process is atomic by virtue of
 * the event loop, and across processes is serialized by SQLite's writer
 * lock — so the claim compare-and-set and the nonce ledger hold either way.
 */
export type SqliteStoreOptions = {
  /** How long a writer waits on the SQLite lock before erroring. */
  busyTimeoutMs?: number;
  /** Journal mode; WAL is the right default for a long-lived server. */
  journalMode?: "WAL" | "DELETE";
};

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

export class SqliteStore implements PlaneStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string, options: SqliteStoreOptions = {}) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`PRAGMA journal_mode = ${options.journalMode ?? "WAL"}`);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(
      `PRAGMA busy_timeout = ${options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS}`
    );
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        pool TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        claimed_by TEXT,
        record TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runs_pool_status ON runs(pool, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_runs_updated ON runs(updated_at);

      CREATE TABLE IF NOT EXISTS events (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ts TEXT NOT NULL,
        event TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

      CREATE TABLE IF NOT EXISTS receipts (
        run_id TEXT PRIMARY KEY,
        receipt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS blobs (
        hash TEXT PRIMARY KEY,
        content BLOB NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runners (
        runner_id TEXT PRIMARY KEY,
        pool TEXT NOT NULL,
        public_key_pem TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        enrolled_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS principals (
        principal_id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );

      CREATE TABLE IF NOT EXISTS enroll_tokens (
        token_hash TEXT PRIMARY KEY,
        pool TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      );

      CREATE TABLE IF NOT EXISTS claim_nonces (
        nonce TEXT PRIMARY KEY,
        expires_at_ms INTEGER NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  // ---- Runs ----

  saveRun(record: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, status, pool, created_at, updated_at, claimed_by, record)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           pool = excluded.pool,
           updated_at = excluded.updated_at,
           claimed_by = excluded.claimed_by,
           record = excluded.record`
      )
      .run(
        record.id,
        record.status,
        record.request.pool,
        record.createdAt,
        record.updatedAt,
        record.claimedBy ?? null,
        JSON.stringify(record)
      );
  }

  // Rows in this database are written exclusively by this store from typed
  // records; the JSON casts on read trust our own writes, which is the same
  // trust boundary as the database file itself. (A corrupted file fails at
  // JSON.parse with a loud error, not silently.)
  getRun(runId: string): RunRecord | undefined {
    const row = this.db
      .prepare("SELECT record FROM runs WHERE id = ?")
      .get(runId) as { record: string } | undefined;
    return row ? (JSON.parse(row.record) as RunRecord) : undefined;
  }

  listRuns(): RunRecord[] {
    const rows = this.db
      .prepare("SELECT record FROM runs ORDER BY created_at DESC")
      .all() as { record: string }[];
    return rows.map((r) => JSON.parse(r.record) as RunRecord);
  }

  claimNextRun(
    pool: string,
    runnerId: string,
    now: string
  ): RunRecord | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          `SELECT record FROM runs
           WHERE pool = ? AND status = 'created'
           ORDER BY created_at ASC LIMIT 1`
        )
        .get(pool) as { record: string } | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        return undefined;
      }
      const record = JSON.parse(row.record) as RunRecord;
      record.status = "claimed";
      record.claimedBy = runnerId;
      record.updatedAt = now;
      const result = this.db
        .prepare(
          `UPDATE runs SET status = ?, claimed_by = ?, updated_at = ?, record = ?
           WHERE id = ? AND status = 'created'`
        )
        .run("claimed", runnerId, now, JSON.stringify(record), record.id);
      // BEGIN IMMEDIATE means no other writer ran between SELECT and UPDATE,
      // but verify the compare-and-set anyway so a logic regression surfaces
      // as "no claim" rather than two runners holding the same run.
      if (Number(result.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      this.db.exec("COMMIT");
      return record;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // ---- Events ----

  appendEvents(runId: string, events: ChainedEvent[]): void {
    if (events.length === 0) return;
    const stmt = this.db.prepare(
      "INSERT INTO events (run_id, seq, ts, event) VALUES (?, ?, ?, ?)"
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const event of events) {
        stmt.run(runId, event.seq, event.ts, JSON.stringify(event));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getEvents(runId: string): ChainedEvent[] {
    const rows = this.db
      .prepare("SELECT event FROM events WHERE run_id = ? ORDER BY seq ASC")
      .all(runId) as { event: string }[];
    return rows.map((r) => JSON.parse(r.event) as ChainedEvent);
  }

  exportEvents(sinceMs: number): { runId: string; event: ChainedEvent }[] {
    // Filter in SQL on the indexed ts column. Event timestamps are canonical
    // ISO-8601 UTC strings, so lexicographic comparison matches chronological
    // order and the cutoff can be passed as an ISO string.
    const sinceIso = new Date(Math.max(sinceMs, 0)).toISOString();
    const rows = this.db
      .prepare(
        `SELECT run_id, event FROM events
         WHERE ts >= ? ORDER BY run_id ASC, seq ASC`
      )
      .all(sinceIso) as { run_id: string; event: string }[];
    return rows.map((row) => ({
      runId: row.run_id,
      event: JSON.parse(row.event) as ChainedEvent
    }));
  }

  // ---- Receipts ----

  saveReceipt(runId: string, receipt: Receipt): void {
    this.db
      .prepare(
        `INSERT INTO receipts (run_id, receipt) VALUES (?, ?)
         ON CONFLICT(run_id) DO UPDATE SET receipt = excluded.receipt`
      )
      .run(runId, JSON.stringify(receipt));
  }

  getReceipt(runId: string): Receipt | undefined {
    const row = this.db
      .prepare("SELECT receipt FROM receipts WHERE run_id = ?")
      .get(runId) as { receipt: string } | undefined;
    return row ? (JSON.parse(row.receipt) as Receipt) : undefined;
  }

  // ---- Blobs ----

  putBlob(content: Buffer): string {
    const hash = sha256Hex(content);
    this.db
      .prepare("INSERT OR IGNORE INTO blobs (hash, content) VALUES (?, ?)")
      .run(hash, content);
    return hash;
  }

  getBlob(hash: string): Buffer | undefined {
    if (!/^[0-9a-f]{64}$/.test(hash)) return undefined;
    const row = this.db
      .prepare("SELECT content FROM blobs WHERE hash = ?")
      .get(hash) as { content: Uint8Array } | undefined;
    return row ? Buffer.from(row.content) : undefined;
  }

  // ---- Runners ----

  saveRunner(record: RunnerRecord): void {
    this.db
      .prepare(
        `INSERT INTO runners (runner_id, pool, public_key_pem, token_hash, enrolled_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(runner_id) DO UPDATE SET
           pool = excluded.pool,
           public_key_pem = excluded.public_key_pem,
           token_hash = excluded.token_hash,
           enrolled_at = excluded.enrolled_at`
      )
      .run(
        record.runnerId,
        record.pool,
        record.publicKeyPem,
        record.tokenHash,
        record.enrolledAt
      );
  }

  private runnerFromRow(row: {
    runner_id: string;
    pool: string;
    public_key_pem: string;
    token_hash: string;
    enrolled_at: string;
  }): RunnerRecord {
    return {
      runnerId: row.runner_id,
      pool: row.pool,
      publicKeyPem: row.public_key_pem,
      tokenHash: row.token_hash,
      enrolledAt: row.enrolled_at
    };
  }

  getRunnerByTokenHash(tokenHash: string): RunnerRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM runners WHERE token_hash = ?")
      .get(tokenHash) as Parameters<SqliteStore["runnerFromRow"]>[0] | undefined;
    return row ? this.runnerFromRow(row) : undefined;
  }

  getRunnerById(runnerId: string): RunnerRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM runners WHERE runner_id = ?")
      .get(runnerId) as Parameters<SqliteStore["runnerFromRow"]>[0] | undefined;
    return row ? this.runnerFromRow(row) : undefined;
  }

  listRunners(): RunnerRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM runners ORDER BY enrolled_at ASC")
      .all() as Parameters<SqliteStore["runnerFromRow"]>[0][];
    return rows.map((r) => this.runnerFromRow(r));
  }

  // ---- Principals ----

  savePrincipal(record: PrincipalRecord): void {
    this.db
      .prepare(
        `INSERT INTO principals (principal_id, name, role, token_hash, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(principal_id) DO UPDATE SET
           name = excluded.name,
           role = excluded.role,
           token_hash = excluded.token_hash,
           revoked_at = excluded.revoked_at`
      )
      .run(
        record.principalId,
        record.name,
        record.role,
        record.tokenHash,
        record.createdAt,
        record.revokedAt ?? null
      );
  }

  private principalFromRow(row: {
    principal_id: string;
    name: string;
    role: string;
    token_hash: string;
    created_at: string;
    revoked_at: string | null;
  }): PrincipalRecord {
    if (!isPrincipalRole(row.role)) {
      throw new Error(
        `principal ${row.principal_id} has unknown role "${row.role}" in store`
      );
    }
    return {
      principalId: row.principal_id,
      name: row.name,
      role: row.role,
      tokenHash: row.token_hash,
      createdAt: row.created_at,
      ...(row.revoked_at ? { revokedAt: row.revoked_at } : {})
    };
  }

  getPrincipalByTokenHash(tokenHash: string): PrincipalRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM principals WHERE token_hash = ?")
      .get(tokenHash) as
      | Parameters<SqliteStore["principalFromRow"]>[0]
      | undefined;
    return row ? this.principalFromRow(row) : undefined;
  }

  getPrincipalByName(name: string): PrincipalRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM principals WHERE name = ?")
      .get(name) as Parameters<SqliteStore["principalFromRow"]>[0] | undefined;
    return row ? this.principalFromRow(row) : undefined;
  }

  listPrincipals(): PrincipalRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM principals ORDER BY created_at ASC")
      .all() as Parameters<SqliteStore["principalFromRow"]>[0][];
    return rows.map((r) => this.principalFromRow(r));
  }

  revokePrincipal(principalId: string, now: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE principals SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL"
      )
      .run(now, principalId);
    return result.changes > 0;
  }

  // ---- Enroll tokens ----

  saveEnrollToken(record: EnrollTokenRecord): void {
    this.db
      .prepare(
        `INSERT INTO enroll_tokens (token_hash, pool, created_at, expires_at, used_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        record.tokenHash,
        record.pool ?? null,
        record.createdAt,
        record.expiresAt,
        record.usedAt ?? null
      );
  }

  consumeEnrollToken(
    tokenHash: string,
    now: string
  ): EnrollTokenRecord | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT * FROM enroll_tokens WHERE token_hash = ?")
        .get(tokenHash) as
        | {
            token_hash: string;
            pool: string | null;
            created_at: string;
            expires_at: string;
            used_at: string | null;
          }
        | undefined;
      if (
        !row ||
        row.used_at !== null ||
        // Compare against the caller-supplied clock so tests can inject time.
        new Date(row.expires_at).getTime() < new Date(now).getTime()
      ) {
        this.db.exec("COMMIT");
        return undefined;
      }
      this.db
        .prepare("UPDATE enroll_tokens SET used_at = ? WHERE token_hash = ?")
        .run(now, tokenHash);
      this.db.exec("COMMIT");
      return {
        tokenHash: row.token_hash,
        ...(row.pool ? { pool: row.pool } : {}),
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        usedAt: now
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // ---- Claim nonces ----

  recordClaimNonce(nonce: string, expiresAtMs: number): boolean {
    const result = this.db
      .prepare("INSERT OR IGNORE INTO claim_nonces (nonce, expires_at_ms) VALUES (?, ?)")
      .run(nonce, expiresAtMs);
    return result.changes > 0;
  }

  pruneClaimNonces(nowMs: number): number {
    const result = this.db
      .prepare("DELETE FROM claim_nonces WHERE expires_at_ms <= ?")
      .run(nowMs);
    return Number(result.changes);
  }

  // ---- Retention / GC ----

  deleteRunsUpdatedBefore(
    cutoffMs: number,
    terminalStatuses: RunStatus[]
  ): string[] {
    const placeholders = terminalStatuses.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT id, updated_at FROM runs WHERE status IN (${placeholders})`
      )
      .all(...terminalStatuses) as { id: string; updated_at: string }[];
    const doomed = rows
      .filter((r) => new Date(r.updated_at).getTime() < cutoffMs)
      .map((r) => r.id);
    if (doomed.length === 0) return [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of doomed) {
        this.db.prepare("DELETE FROM events WHERE run_id = ?").run(id);
        this.db.prepare("DELETE FROM receipts WHERE run_id = ?").run(id);
        this.db.prepare("DELETE FROM runs WHERE id = ?").run(id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return doomed;
  }

  deleteBlobsExcept(keep: Set<string>): number {
    const hashes = (
      this.db.prepare("SELECT hash FROM blobs").all() as { hash: string }[]
    ).map((r) => r.hash);
    const doomed = hashes.filter((h) => !keep.has(h));
    if (doomed.length === 0) return 0;
    const stmt = this.db.prepare("DELETE FROM blobs WHERE hash = ?");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const hash of doomed) stmt.run(hash);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return doomed.length;
  }

  countBlobs(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM blobs").get() as {
      n: number | bigint;
    };
    return Number(row.n);
  }
}
