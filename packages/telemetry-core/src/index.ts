import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";

import { writeFileAtomic } from "@routekit/runtime";

export type ConsentFile = {
  enabled: boolean;
  installId?: string;
  decidedAt?: string;
};
export type ConsentDecision = {
  enabled: boolean;
  source: "do-not-track" | "env" | "config" | "default";
  installId?: string;
};
export type ConsentOptions = {
  path: () => string;
  environmentVariable: string;
  doNotTrackVariable?: string;
  now?: () => Date;
  randomId?: () => string;
};

/** Fields shared by every CLI's anonymous command event. */
export const CLI_COMMAND_TELEMETRY_FIELDS = [
  "command",
  "cli_version",
  "os",
  "arch",
  "node_major",
  "duration_bucket",
  "exit_kind",
  "is_ci"
] as const;

export type TelemetryFieldMap = Readonly<Record<string, readonly string[]>>;

/**
 * Shared machine-readable consent status. Products may add operational fields
 * and render this metadata differently, but consent semantics stay identical.
 */
export function telemetryStatusMetadata(
  decision: ConsentDecision,
  fields: TelemetryFieldMap
): {
  enabled: boolean;
  source: ConsentDecision["source"];
  installId: string | null;
  fields: TelemetryFieldMap;
} {
  return {
    enabled: decision.enabled,
    source: decision.source,
    installId: decision.installId ?? null,
    fields
  };
}

const truthy = (value: string | undefined): boolean =>
  value !== undefined && ["1", "true", "on", "yes"].includes(value.toLowerCase());
const falsy = (value: string | undefined): boolean =>
  value !== undefined && ["0", "false", "off", "no"].includes(value.toLowerCase());

export function createConsentManager(options: ConsentOptions) {
  const read = (): ConsentFile | undefined => {
    const path = options.path();
    if (!existsSync(path)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as ConsentFile).enabled === "boolean"
      ) {
        return parsed as ConsentFile;
      }
    } catch {
      // Corrupt consent is undecided and therefore disabled.
    }
    return undefined;
  };
  const write = (value: ConsentFile): void => {
    const path = options.path();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  };
  const resolve = (env: NodeJS.ProcessEnv = process.env): ConsentDecision => {
    if (truthy(env[options.doNotTrackVariable ?? "DO_NOT_TRACK"])) {
      return { enabled: false, source: "do-not-track" };
    }
    const override = env[options.environmentVariable];
    if (falsy(override)) return { enabled: false, source: "env" };
    const file = read();
    if (truthy(override)) {
      return {
        enabled: true,
        source: "env",
        installId: file?.installId ?? (options.randomId ?? randomUUID)()
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
  };
  return {
    path: options.path,
    read,
    resolve,
    enable(): ConsentFile {
      const existing = read();
      const file: ConsentFile = {
        enabled: true,
        installId: existing?.installId ?? (options.randomId ?? randomUUID)(),
        decidedAt: (options.now ?? (() => new Date()))().toISOString()
      };
      write(file);
      return file;
    },
    disable(): void {
      write({
        enabled: false,
        decidedAt: (options.now ?? (() => new Date()))().toISOString()
      });
    },
    clear(): void {
      rmSync(options.path(), { force: true });
    }
  };
}

export function durationBucket(ms: number): string {
  if (ms < 1_000) return "<1s";
  if (ms < 10_000) return "1-10s";
  if (ms < 60_000) return "10-60s";
  if (ms < 300_000) return "1-5m";
  if (ms < 1_800_000) return "5-30m";
  return ">30m";
}

export function allowlistedProperties(
  source: Record<string, unknown>,
  allow: readonly string[]
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const key of allow) {
    if (source[key] !== undefined) properties[key] = source[key];
  }
  return properties;
}

export function anonymousEventProperties(
  properties: Record<string, unknown>
): Record<string, unknown> {
  return { ...properties, $process_person_profile: false, $ip: null };
}

export async function boundedShutdown(
  shutdown: () => Promise<unknown>,
  timeoutMs = 2_000
): Promise<void> {
  await Promise.race([
    shutdown().then(
      () => undefined,
      () => undefined
    ),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
  ]);
}
