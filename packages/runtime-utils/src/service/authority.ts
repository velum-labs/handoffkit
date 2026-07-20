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
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";

import { randomId, sleep } from "../index.js";

import { processAlive } from "./records.js";

export type LifecycleLock = {
  path: string;
  nonce: string;
  release(): void;
};

type LockRecord = { pid: number; nonce: string; acquiredAt: string };

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

function tryAcquire(path: string): LifecycleLock | undefined {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
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
        acquiredAt: new Date().toISOString()
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

export async function acquireLifecycleLock(
  path: string,
  options: { timeoutMs?: number; pollMs?: number } = {}
): Promise<LifecycleLock> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 75;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lock = tryAcquire(path);
    if (lock !== undefined) return lock;
    const current = readLock(path);
    if (current === undefined || !processAlive(current.pid)) {
      // Unknown/corrupt locks are safe to remove only when no parsable live
      // owner exists. Atomic create on the next loop decides the winner.
      rmSync(path, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for lifecycle lock ${path} (owned by pid ${current.pid})`
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

