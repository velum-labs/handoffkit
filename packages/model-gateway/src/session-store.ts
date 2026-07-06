/**
 * Durable session store for the fusion gateway (WS4 — session lifecycle &
 * continuity).
 *
 * Why a JSONL event log (and not SQLite): the lightest possible dependency is
 * "none" — Node built-ins only. `node:sqlite` is still experimental (and gated
 * behind a flag on some runtimes the CLI must support), and a JSONL layout
 * deliberately mirrors FusionKit's Python `FileSystemRunStore` (an append-only
 * `events.jsonl` + a small `summary` JSON per run): same filesystem event-log
 * shape, trivially inspectable with `cat`/`jq`, append-durable, and zero new
 * packages to ship. We store one directory per session under
 * `~/.fusionkit/sessions/<id>/`:
 *
 *   meta.json    — a fast-read summary (id, tool, panel models, judge/default
 *                  model, repo, trace id, span, created/updated timestamps).
 *   turns.jsonl  — one line per user turn: the conversation snapshot that drove
 *                  the panel for that turn plus the candidate trajectories it
 *                  produced (the per-turn candidate cache).
 *
 * BOUNDARY WITH FUSIONKIT. The Python `FusionRunManager`/`FileSystemRunStore`
 * persists individual *runs* — a single inference request's lifecycle
 * (trajectories, tool pauses, idempotency). A gateway/harness *session* is a
 * different unit: it spans many turns, each of which is itself a separate panel
 * run, and it lives entirely in the Node CLI process. Rather than overload the
 * per-run Python store (whose idempotency + state machine do not fit a
 * long-lived multi-turn harness session), the Node session store stays
 * authoritative for harness + gateway sessions, and is intentionally shaped like
 * the Python store so the two read alike. Raw-inference sessions hitting the
 * gateway's OpenAI-compatible `/v1/chat/completions` go through the same
 * {@link FusionBackend} and are therefore persisted/resumable here too.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CostLedgerEntry, SessionCost } from "./cost.js";
import type { ChatMessageLike, WireTrajectory } from "./fusion-backend.js";

/** One persisted user turn: the messages that drove the panel + its candidates. */
export type SessionTurnRecord = {
  /** 1-based user-turn index (matches {@link FusionBackend}'s turn counter). */
  turn: number;
  /** The full OpenAI-style message array as the panel saw it for this turn. */
  messages: ChatMessageLike[];
  /** The candidate trajectories the panel produced (the per-turn cache). */
  candidates: WireTrajectory[];
  /** Epoch millis the turn was recorded. */
  recordedAt: number;
};

/** The fast-read session header persisted to `meta.json`. */
export type SessionMeta = {
  /** Stable session id (the gateway's session-key derivation is the seed). */
  id: string;
  /** The launched coding harness (codex/claude/cursor/...), if known. */
  tool?: string;
  /** The coding workspace the panel fused over, if known. */
  repo?: string;
  /** The panel members at session creation. */
  models?: Array<{ id: string; model: string }>;
  /** The judge/synthesizer model name, if configured. */
  judgeModel?: string;
  /** The fused model label advertised to the harness. */
  defaultModel?: string;
  /** The trace id minted for this session (stable across resume). */
  traceId: string;
  /** The session root span id. */
  sessionSpan: string;
  /** Epoch millis the session was created. */
  createdAt: number;
  /** Epoch millis of the most recent turn (last activity). */
  updatedAt: number;
  /**
   * Running token + cost accounting for the session (WS7). Accumulates the
   * gateway-observed usage/cost across turns (vendor responses for passthrough
   * turns; the judge/synthesis step for fused turns). Absent on sessions that
   * predate cost metering.
   */
  cost?: SessionCost;
};

/** A fully-loaded session: its header plus every recorded turn, in turn order. */
export type PersistedSession = {
  meta: SessionMeta;
  turns: SessionTurnRecord[];
  costLedger: CostLedgerEntry[];
};

/** A listing row: the header plus the turn count (for `sessions list`). */
export type SessionSummary = SessionMeta & { turnCount: number };

/**
 * A durable, process-independent store for gateway sessions. The in-memory
 * session map in {@link FusionBackend} is a hot cache *in front of* this; the
 * store itself has no TTL (sessions persist until `sessions rm`).
 */
export interface SessionStore {
  /** Load a session (header + turns), or `undefined` if it does not exist. */
  load(id: string): PersistedSession | undefined;
  /** Create or overwrite a session's header. */
  saveMeta(meta: SessionMeta): void;
  /** Append a turn record and bump the session's last-activity timestamp. */
  appendTurn(id: string, turn: SessionTurnRecord): void;
  /** Persist the session's running token + cost accounting (WS7). No-op if absent. */
  recordCost(id: string, cost: SessionCost): void;
  /** Append one stage-aware cost ledger entry and persist the updated rollup. */
  recordCostEntry(id: string, entry: CostLedgerEntry, cost: SessionCost): void;
  /** Summaries of every stored session, most-recently-active first. */
  list(): SessionSummary[];
  /** Remove a session and all its data. Returns whether anything was removed. */
  remove(id: string): boolean;
}

/** The default on-disk sessions root: `$FUSIONKIT_SESSIONS_DIR` or `~/.fusionkit/sessions`. */
export function defaultSessionsDir(): string {
  const override = process.env.FUSIONKIT_SESSIONS_DIR;
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), ".fusionkit", "sessions");
}

/** A filesystem-backed {@link SessionStore} (JSONL event log; Node built-ins only). */
export class FileSystemSessionStore implements SessionStore {
  readonly #root: string;

  constructor(root: string = defaultSessionsDir()) {
    this.#root = root;
  }

  /** The on-disk root this store reads/writes. */
  get root(): string {
    return this.#root;
  }

  load(id: string): PersistedSession | undefined {
    const metaPath = this.#metaPath(id);
    if (!existsSync(metaPath)) return undefined;
    let meta: SessionMeta;
    try {
      meta = JSON.parse(readFileSync(metaPath, "utf8")) as SessionMeta;
    } catch {
      return undefined;
    }
    const byTurn = new Map<number, SessionTurnRecord>();
    const turnsPath = this.#turnsPath(id);
    if (existsSync(turnsPath)) {
      for (const line of readFileSync(turnsPath, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          const record = JSON.parse(trimmed) as SessionTurnRecord;
          // Last write wins per turn index, so a re-recorded turn is idempotent.
          byTurn.set(record.turn, record);
        } catch {
          // Skip a torn/partial trailing line rather than failing the load.
        }
      }
    }
    const turns = [...byTurn.values()].sort((left, right) => left.turn - right.turn);
    const costLedger: CostLedgerEntry[] = [];
    const costPath = this.#costPath(id);
    if (existsSync(costPath)) {
      for (const line of readFileSync(costPath, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          costLedger.push(JSON.parse(trimmed) as CostLedgerEntry);
        } catch {
          // Skip torn/partial lines.
        }
      }
    }
    return { meta, turns, costLedger };
  }

  saveMeta(meta: SessionMeta): void {
    mkdirSync(this.#dir(meta.id), { recursive: true });
    this.#writeJsonAtomic(this.#metaPath(meta.id), meta);
  }

  appendTurn(id: string, turn: SessionTurnRecord): void {
    mkdirSync(this.#dir(id), { recursive: true });
    appendFileSync(this.#turnsPath(id), `${JSON.stringify(turn)}\n`, "utf8");
    // Bump the header's last-activity stamp so `sessions list` ordering tracks
    // real use (best-effort: the header should already exist from creation).
    const metaPath = this.#metaPath(id);
    if (!existsSync(metaPath)) return;
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as SessionMeta;
      meta.updatedAt = turn.recordedAt;
      this.#writeJsonAtomic(metaPath, meta);
    } catch {
      // A corrupt header should not block turn persistence.
    }
  }

  recordCost(id: string, cost: SessionCost): void {
    const metaPath = this.#metaPath(id);
    if (!existsSync(metaPath)) return;
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as SessionMeta;
      meta.cost = cost;
      // Cost accrual is session activity: a resumed session that replays
      // stored candidates never re-appends turns, so without this bump it
      // would look idle to `sessions list` and the end-of-run receipt.
      meta.updatedAt = Date.now();
      this.#writeJsonAtomic(metaPath, meta);
    } catch {
      // A corrupt header should not block the turn; cost is best-effort.
    }
  }

  recordCostEntry(id: string, entry: CostLedgerEntry, cost: SessionCost): void {
    mkdirSync(this.#dir(id), { recursive: true });
    appendFileSync(this.#costPath(id), `${JSON.stringify(entry)}\n`, "utf8");
    this.recordCost(id, cost);
  }

  list(): SessionSummary[] {
    if (!existsSync(this.#root)) return [];
    const summaries: SessionSummary[] = [];
    for (const entry of readdirSync(this.#root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const loaded = this.load(entry.name);
      if (loaded === undefined) continue;
      summaries.push({ ...loaded.meta, turnCount: loaded.turns.length });
    }
    summaries.sort((left, right) => right.updatedAt - left.updatedAt);
    return summaries;
  }

  remove(id: string): boolean {
    const dir = this.#dir(id);
    if (!existsSync(dir)) return false;
    rmSync(dir, { recursive: true, force: true });
    return true;
  }

  #dir(id: string): string {
    return join(this.#root, id);
  }

  #metaPath(id: string): string {
    return join(this.#dir(id), "meta.json");
  }

  #turnsPath(id: string): string {
    return join(this.#dir(id), "turns.jsonl");
  }

  #costPath(id: string): string {
    return join(this.#dir(id), "costs.jsonl");
  }

  /** Write JSON via a temp file + rename so a reader never sees a half-written header. */
  #writeJsonAtomic(path: string, value: unknown): void {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), "utf8");
    renameSync(tmp, path);
  }
}

/** An in-memory {@link SessionStore} for tests and ephemeral runs. */
export class InMemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, PersistedSession>();

  load(id: string): PersistedSession | undefined {
    const session = this.#sessions.get(id);
    if (session === undefined) return undefined;
    return {
      meta: { ...session.meta },
      turns: session.turns.map((turn) => ({ ...turn })),
      costLedger: session.costLedger.map((entry) => ({ ...entry }))
    };
  }

  saveMeta(meta: SessionMeta): void {
    const existing = this.#sessions.get(meta.id);
    this.#sessions.set(meta.id, {
      meta: { ...meta },
      turns: existing?.turns ?? [],
      costLedger: existing?.costLedger ?? []
    });
  }

  appendTurn(id: string, turn: SessionTurnRecord): void {
    const existing = this.#sessions.get(id);
    if (existing === undefined) return;
    existing.turns = [...existing.turns.filter((entry) => entry.turn !== turn.turn), turn].sort(
      (left, right) => left.turn - right.turn
    );
    existing.meta = { ...existing.meta, updatedAt: turn.recordedAt };
  }

  recordCost(id: string, cost: SessionCost): void {
    const existing = this.#sessions.get(id);
    if (existing === undefined) return;
    existing.meta = { ...existing.meta, cost, updatedAt: Date.now() };
  }

  recordCostEntry(id: string, entry: CostLedgerEntry, cost: SessionCost): void {
    const existing = this.#sessions.get(id);
    if (existing === undefined) return;
    existing.costLedger = [...existing.costLedger, entry];
    existing.meta = { ...existing.meta, cost };
  }

  list(): SessionSummary[] {
    return [...this.#sessions.values()]
      .map((session) => ({ ...session.meta, turnCount: session.turns.length }))
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  remove(id: string): boolean {
    return this.#sessions.delete(id);
  }
}
