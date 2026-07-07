/**
 * Per-session advisory locking for the on-disk session store (WS10).
 *
 * `~/.fusionkit/sessions` is shared state: several gateway processes (a
 * launched harness run, a `fusionkit serve` instance, the sessions CLI) can
 * mutate the same session concurrently, and `meta.json` updates are
 * read-modify-write (appendTurn bumps `updatedAt`, recordCost replaces
 * `cost`) — an unserialized interleave silently drops whichever field the
 * loser wrote. Two layers, one entry point:
 *
 *  - in-process: a promise-chain mutex per session id, so concurrent async
 *    mutations in one process queue instead of interleaving;
 *  - cross-process: an O_EXCL-style lock directory (`<session>/.lock`,
 *    `mkdirSync` is atomic on every platform we support) holding the owner
 *    pid, acquired with jittered backoff and stolen when stale (owner dead,
 *    or older than the hard TTL).
 *
 * Locks are held only for the duration of one store mutation (small file
 * writes), so the wait budget is generous relative to the critical section.
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** How long a lock may exist before it is considered abandoned outright. */
const STALE_LOCK_MS = 10_000;
/** Total budget to wait for a contended lock before failing loudly. */
const ACQUIRE_TIMEOUT_MS = 5_000;
/** Backoff bounds between acquisition attempts (jittered uniform). */
const RETRY_MIN_MS = 5;
const RETRY_MAX_MS = 25;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: exists but owned by another user — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A lock is stale when its owner is gone or it outlived the hard TTL. */
function lockIsStale(lockDir: string): boolean {
  try {
    const age = Date.now() - statSync(lockDir).mtimeMs;
    if (age > STALE_LOCK_MS) return true;
    const pid = Number.parseInt(readFileSync(join(lockDir, "pid"), "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 && !pidAlive(pid);
  } catch {
    // Unreadable while probing (owner mid-release, torn pid file): not
    // provably stale — let the retry loop and the TTL decide.
    return false;
  }
}

/**
 * Serializes mutations of one session across async tasks and processes.
 * `sessionDir` must be the session's own directory (created on demand).
 */
export class SessionLockManager {
  /** Tail of the in-process mutex chain per session id. */
  readonly #chains = new Map<string, Promise<void>>();

  /**
   * Run `fn` while holding the session's lock. Reentrancy is not supported:
   * `fn` must not call `withLock` for the same id.
   */
  async withLock<T>(id: string, sessionDir: string, fn: () => Promise<T> | T): Promise<T> {
    const previous = this.#chains.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#chains.set(id, current);
    await previous;
    try {
      await this.#acquireFileLock(id, sessionDir);
      try {
        return await fn();
      } finally {
        this.#releaseFileLock(sessionDir);
      }
    } finally {
      if (this.#chains.get(id) === current) this.#chains.delete(id);
      release();
    }
  }

  async #acquireFileLock(id: string, sessionDir: string): Promise<void> {
    const lockDir = join(sessionDir, ".lock");
    const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
    for (;;) {
      mkdirSync(sessionDir, { recursive: true });
      try {
        mkdirSync(lockDir); // atomic: fails with EEXIST when held
        writeFileSync(join(lockDir, "pid"), String(process.pid), "utf8");
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (lockIsStale(lockDir)) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `session ${id} is locked by another process (${lockDir}); ` +
            "waited 5s — remove the .lock directory if the owner crashed"
        );
      }
      await sleep(RETRY_MIN_MS + Math.random() * (RETRY_MAX_MS - RETRY_MIN_MS));
    }
  }

  #releaseFileLock(sessionDir: string): void {
    rmSync(join(sessionDir, ".lock"), { recursive: true, force: true });
  }
}
