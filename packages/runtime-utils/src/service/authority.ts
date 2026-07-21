/**
 * Singleton authority and lifecycle locking.
 *
 * Unlike a bare `wx` lock, this lock records its owner's pid and a random
 * nonce. A process that died mid-lifecycle cannot wedge the service forever:
 * the next contender reaps the lock only after confirming the owner pid is
 * gone. Release is nonce-guarded so an old owner cannot delete a successor's
 * lock.
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";

import { randomId, sleep } from "../index.js";

import { processAlive, processIdentity } from "./records.js";

export type LifecycleLock = {
  path: string;
  nonce: string;
  release(): void;
};

type LockRecord = {
  pid: number;
  nonce: string;
  acquiredAt: string;
  processIdentity?: string;
};
const LOCK_STABILIZE_MS = 2_000;

function readLock(path: string): LockRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<LockRecord>;
    return typeof value.pid === "number" &&
      typeof value.nonce === "string" &&
      typeof value.acquiredAt === "string"
      ? (value as LockRecord)
      : undefined;
  } catch {
    return undefined;
  }
}

function tryAcquire(path: string, ignoreReaper = false): LifecycleLock | undefined {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!ignoreReaper) {
    try {
      statSync(`${path}.reap`);
      return undefined;
    } catch {
      // no reaper
    }
  }
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
  const nonce = randomId(24);
  try {
    writeFileSync(
      fd,
      `${JSON.stringify({
        pid: process.pid,
        nonce,
        acquiredAt: new Date().toISOString(),
        ...(processIdentity(process.pid) !== undefined
          ? { processIdentity: processIdentity(process.pid) }
          : {})
      } satisfies LockRecord)}\n`
    );
  } finally {
    closeSync(fd);
  }
  let released = false;
  return {
    path,
    nonce,
    release() {
      if (released) return;
      released = true;
      const current = readLock(path);
      if (current?.nonce === nonce) rmSync(path, { force: true });
    }
  };
}

function tryReapAndAcquire(path: string): LifecycleLock | undefined {
  const reaperPath = `${path}.reap`;
  const nonce = randomId(24);
  let reaper: number;
  try {
    reaper = openSync(reaperPath, "wx", 0o600);
  } catch {
    return undefined;
  }
  writeFileSync(
    reaper,
    `${JSON.stringify({
      pid: process.pid,
      nonce,
      acquiredAt: new Date().toISOString(),
      ...(processIdentity(process.pid) !== undefined
        ? { processIdentity: processIdentity(process.pid) }
        : {})
    } satisfies LockRecord)}\n`
  );
  closeSync(reaper);
  try {
    const current = readLock(path);
    let stale = false;
    if (current === undefined) {
      try {
        stale = Date.now() - statSync(path).mtimeMs >= LOCK_STABILIZE_MS;
      } catch {
        stale = true;
      }
    } else {
      const acquiredAt = Date.parse(current.acquiredAt);
      stale =
        !processAlive(current.pid, current.processIdentity) &&
        (!Number.isFinite(acquiredAt) || Date.now() - acquiredAt >= LOCK_STABILIZE_MS);
    }
    if (!stale) return undefined;
    rmSync(path, { force: true });
    return tryAcquire(path, true);
  } finally {
    if (readLock(reaperPath)?.nonce === nonce) rmSync(reaperPath, { force: true });
  }
}

export async function acquireLifecycleLock(
  path: string,
  options: {
    timeoutMs?: number;
    pollMs?: number;
    /** Abort contention early when another authority becomes discoverable. */
    onWait?: () => Error | undefined | Promise<Error | undefined>;
  } = {}
): Promise<LifecycleLock> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 75;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const reaperPath = `${path}.reap`;
      const reaper = readLock(reaperPath);
      if (
        reaper !== undefined &&
        !processAlive(reaper.pid, reaper.processIdentity) &&
        Date.now() - Date.parse(reaper.acquiredAt) >= LOCK_STABILIZE_MS
      ) {
        rmSync(reaperPath, { force: true });
      } else if (reaper === undefined) {
        try {
          if (Date.now() - statSync(reaperPath).mtimeMs >= LOCK_STABILIZE_MS) {
            rmSync(reaperPath, { force: true });
          }
        } catch {
          // no reaper
        }
      }
    } catch {
      // no reaper
    }
    const lock = tryAcquire(path);
    if (lock !== undefined) return lock;
    const current = readLock(path);
    if (current === undefined) {
      // `open("wx")` publishes the path just before the owner JSON is written.
      // Never steal a fresh unreadable lock during that small publication gap.
      let ageMs = 0;
      try {
        ageMs = Date.now() - statSync(path).mtimeMs;
      } catch {
        ageMs = 0;
      }
      if (ageMs >= LOCK_STABILIZE_MS) {
        const recovered = tryReapAndAcquire(path);
        if (recovered !== undefined) return recovered;
      }
    } else if (!processAlive(current.pid, current.processIdentity)) {
      const acquiredAt = Date.parse(current.acquiredAt);
      if (!Number.isFinite(acquiredAt) || Date.now() - acquiredAt >= LOCK_STABILIZE_MS) {
        const recovered = tryReapAndAcquire(path);
        if (recovered !== undefined) return recovered;
      }
    }
    const waitError = await options.onWait?.();
    if (waitError !== undefined) throw waitError;
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for lifecycle lock ${path}` +
          (current === undefined ? "" : ` (owned by pid ${current.pid})`)
      );
    }
    await sleep(pollMs);
  }
}

export function nextServiceGeneration(previous: number | undefined): number {
  const base = Number.isSafeInteger(previous) && (previous ?? 0) >= 0 ? previous ?? 0 : 0;
  if (base >= Number.MAX_SAFE_INTEGER) throw new Error("service generation exhausted");
  return base + 1;
}
