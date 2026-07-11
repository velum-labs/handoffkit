/**
 * Telemetry consent: opt-in, default off, with hard kill switches.
 *
 * Resolution precedence (first match wins):
 *   1. DO_NOT_TRACK=1        — the industry-standard universal opt-out
 *   2. FUSIONKIT_TELEMETRY   — 0/false/off forces off, 1/true/on forces on
 *   3. ~/.fusionkit/telemetry.json — the persisted `fusionkit telemetry on/off`
 *   4. default               — off (CI environments never default on)
 *
 * The anonymous install id is a random UUID created only when telemetry is
 * enabled; `fusionkit telemetry off` deletes it. Nothing else identifies the
 * installation.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type TelemetryFile = {
  enabled: boolean;
  installId?: string;
  decidedAt?: string;
};

export type TelemetryDecision = {
  enabled: boolean;
  /** Which layer decided: kill switch, env, config file, or the default. */
  source: "do-not-track" | "env" | "config" | "default";
  installId?: string;
};

/** The consent file path (FUSIONKIT_TELEMETRY_PATH overrides, for tests). */
export function telemetryPath(): string {
  const override = process.env.FUSIONKIT_TELEMETRY_PATH;
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), ".fusionkit", "telemetry.json");
}

function readFile(): TelemetryFile | undefined {
  const path = telemetryPath();
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as TelemetryFile).enabled === "boolean") {
      return parsed as TelemetryFile;
    }
  } catch {
    // A corrupt consent file reads as undecided (default off).
  }
  return undefined;
}

function truthy(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "on", "yes"].includes(value.toLowerCase());
}

function falsy(value: string | undefined): boolean {
  return value !== undefined && ["0", "false", "off", "no"].includes(value.toLowerCase());
}

/** Resolve the effective telemetry decision (see module doc for precedence). */
export function resolveTelemetry(env: NodeJS.ProcessEnv = process.env): TelemetryDecision {
  if (truthy(env.DO_NOT_TRACK)) return { enabled: false, source: "do-not-track" };
  if (falsy(env.FUSIONKIT_TELEMETRY)) return { enabled: false, source: "env" };
  const file = readFile();
  if (truthy(env.FUSIONKIT_TELEMETRY)) {
    return {
      enabled: true,
      source: "env",
      installId: file?.installId ?? randomUUID()
    };
  }
  if (file !== undefined) {
    return {
      enabled: file.enabled,
      source: "config",
      ...(file.installId !== undefined ? { installId: file.installId } : {})
    };
  }
  return { enabled: false, source: "default" };
}

/** Persist an explicit opt-in, minting the anonymous install id. */
export function enableTelemetry(): TelemetryFile {
  const existing = readFile();
  const file: TelemetryFile = {
    enabled: true,
    installId: existing?.installId ?? randomUUID(),
    decidedAt: new Date().toISOString()
  };
  const path = telemetryPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n");
  return file;
}

/** Persist an explicit opt-out and delete the install id. */
export function disableTelemetry(): void {
  const path = telemetryPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ enabled: false, decidedAt: new Date().toISOString() }, null, 2) + "\n");
}

/** Remove the consent file entirely (used by tests). */
export function clearTelemetryFile(): void {
  rmSync(telemetryPath(), { force: true });
}
