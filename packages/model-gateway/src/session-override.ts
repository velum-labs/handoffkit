/**
 * Per-session model override read by the routing gateway.
 *
 * Written by `fusionkit fusion model` to `~/.fusionkit/session-override.json`.
 */

import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Filename under `~/.fusionkit/` for the session model override. */
export const SESSION_OVERRIDE_BASENAME = "session-override.json";

/** Shape of `~/.fusionkit/session-override.json`. */
export type SessionModelOverride = {
  /** `null` means smart routing (no override). */
  modelId: string | null;
  /** ISO-8601 timestamp when the override was set. */
  setAt: string;
};

/**
 * Path to the session model override file.
 */
export function sessionOverridePath(homeDir: string = homedir()): string {
  return join(homeDir, ".fusionkit", SESSION_OVERRIDE_BASENAME);
}

/**
 * Read the session model override best-effort (missing or invalid file → `undefined`).
 */
export function readSessionModelOverride(homeDir?: string): SessionModelOverride | undefined {
  try {
    const raw = readFileSync(sessionOverridePath(homeDir), "utf8");
    return parseSessionModelOverride(raw);
  } catch {
    // best-effort
  }
  return undefined;
}

/**
 * Async variant of {@link readSessionModelOverride} for hot-path callers that cache reads.
 */
export async function readSessionModelOverrideAsync(
  homeDir?: string
): Promise<SessionModelOverride | undefined> {
  try {
    const raw = await readFile(sessionOverridePath(homeDir), "utf8");
    return parseSessionModelOverride(raw);
  } catch {
    // best-effort
  }
  return undefined;
}

function parseSessionModelOverride(raw: string): SessionModelOverride | undefined {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.setAt !== "string") return undefined;
  if (record.modelId === null) {
    return { modelId: null, setAt: record.setAt };
  }
  if (typeof record.modelId === "string") {
    return { modelId: record.modelId, setAt: record.setAt };
  }
  return undefined;
}
