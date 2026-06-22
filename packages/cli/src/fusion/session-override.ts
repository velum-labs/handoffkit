/**
 * Per-session model override written by `fusionkit fusion model`. The routing
 * gateway should read this file to bypass smart routing when `modelId` is set.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
 * Write the session model override (`modelId: null` selects smart routing).
 */
export function writeSessionModelOverride(
  modelId: string | null,
  options: { homeDir?: string; now?: () => Date } = {}
): string {
  const path = sessionOverridePath(options.homeDir);
  mkdirSync(dirname(path), { recursive: true });
  const payload: SessionModelOverride = {
    modelId,
    setAt: (options.now ?? (() => new Date()))().toISOString()
  };
  writeFileSync(path, JSON.stringify(payload, null, 2) + "\n");
  return path;
}
