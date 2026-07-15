import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { isHarnessKind } from "./kinds.js";
import type { HarnessKind } from "./kinds.js";

export type HarnessAuthStatus = "authenticated" | "unauthenticated" | "unknown";

export type HarnessModelDescriptor = {
  id: string;
  displayName?: string;
};

/**
 * The probed state of one harness CLI: installed / version / auth / models.
 * Consumed by diagnostics and readiness checks (skip with an actionable reason
 * before any spend), and the front-door launchers.
 */
export type HarnessStatus = {
  kind: HarnessKind;
  installed: boolean;
  /** The resolved command the probe ran (when installed). */
  command?: string;
  version?: string;
  auth: { status: HarnessAuthStatus; detail?: string };
  models?: HarnessModelDescriptor[];
  checkedAt: string;
  /** Why the probe itself failed, when it did (distinct from "not installed"). */
  probeError?: string;
};

export const DEFAULT_STATUS_CACHE_DIR = join(homedir(), ".routekit", "harness-status");

/**
 * Read a cached status snapshot. The payload's own `kind` must match the
 * requested kind — the filename alone is never trusted as a routing key.
 */
export function readCachedStatus(
  kind: HarnessKind,
  cacheDir: string = DEFAULT_STATUS_CACHE_DIR
): HarnessStatus | undefined {
  try {
    const raw = readFileSync(join(cacheDir, `${kind}.json`), "utf8");
    const parsed = JSON.parse(raw) as HarnessStatus;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    if (!isHarnessKind(parsed.kind) || parsed.kind !== kind) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** Persist a status snapshot atomically (write temp + rename). */
export function writeCachedStatus(
  status: HarnessStatus,
  cacheDir: string = DEFAULT_STATUS_CACHE_DIR
): void {
  mkdirSync(cacheDir, { recursive: true });
  const target = join(cacheDir, `${status.kind}.json`);
  const temp = join(tmpdir(), `harness-status-${randomUUID()}.json`);
  writeFileSync(temp, `${JSON.stringify(status, null, 2)}\n`);
  try {
    renameSync(temp, target);
  } catch {
    // Cross-device rename fallback: write directly (still a single syscall
    // for the small payload).
    writeFileSync(target, `${JSON.stringify(status, null, 2)}\n`);
  }
}

/** An actionable skip reason when the status is not runnable, else undefined. */
export function statusSkipReason(status: HarnessStatus): string | undefined {
  if (!status.installed) {
    return status.probeError ?? `${status.kind} CLI is not installed or not on PATH.`;
  }
  if (status.auth.status === "unauthenticated") {
    return status.auth.detail ?? `${status.kind} CLI is installed but not logged in.`;
  }
  return undefined;
}
