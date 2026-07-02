/**
 * Persisted cloud-panel cost consent. Once a user has interactively approved
 * running the cloud panel for a given repo + panel combination, that answer is
 * remembered under ~/.fusionkit so the confirmation is a one-time moment, not a
 * per-run toll. Changing the panel (different providers/models) re-asks; `--yes`
 * still skips the prompt without recording anything.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { PanelModelSpec } from "./env.js";

type ConsentFile = Record<string, { approvedAt: string }>;

/** The consent file path (FUSIONKIT_CONSENT_PATH overrides, for tests). */
export function consentPath(): string {
  const override = process.env.FUSIONKIT_CONSENT_PATH;
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), ".fusionkit", "consent.json");
}

/** A stable key for "this repo running this exact panel". */
export function consentKey(repo: string, models: readonly PanelModelSpec[]): string {
  const panel = models
    .map((spec) => `${spec.provider ?? "mlx"}:${spec.model}`)
    .sort()
    .join(",");
  return `${repo}::${panel}`;
}

function readConsentFile(): ConsentFile {
  const path = consentPath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as ConsentFile;
    }
  } catch {
    // A corrupt consent file just means we ask again.
  }
  return {};
}

/** Whether this repo+panel combination was previously approved interactively. */
export function hasCloudConsent(repo: string, models: readonly PanelModelSpec[]): boolean {
  return readConsentFile()[consentKey(repo, models)] !== undefined;
}

/** Record an interactive approval (best-effort; a write failure just re-asks next run). */
export function recordCloudConsent(repo: string, models: readonly PanelModelSpec[]): void {
  try {
    const path = consentPath();
    mkdirSync(dirname(path), { recursive: true });
    const file = readConsentFile();
    file[consentKey(repo, models)] = { approvedAt: new Date().toISOString() };
    writeFileSync(path, JSON.stringify(file, null, 2) + "\n");
  } catch {
    // best-effort
  }
}
