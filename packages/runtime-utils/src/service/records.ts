/**
 * Generalized service records.
 *
 * A service record is the on-disk contract between a long-lived daemon and the
 * CLIs that manage it: `<home>/services/<kind>.json` holds the daemon's pid,
 * URL, version, launch arguments, and owning supervisor. Records are written
 * atomically with 0600 permissions, validated on read, and reaped when the
 * recorded pid is gone, so a crashed daemon never leaves a lying record
 * behind. The store is product-agnostic: each product constructs one with its
 * own state home and product name (RouteKit, FusionKit, ...).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { writeFileAtomic } from "../index.js";

/** Who supervises a running service process. */
export type ServiceSupervisorKind = "systemd" | "launchd" | "detached";

const SUPERVISOR_KINDS: readonly ServiceSupervisorKind[] = ["systemd", "launchd", "detached"];

/**
 * Environment variable a daemonizer or generated unit sets on the service
 * process so the record it writes names its supervisor. Products read it via
 * {@link supervisorFromEnv} when stamping their records.
 */
export const SERVICE_SUPERVISOR_ENV = "VELUM_SERVICE_SUPERVISOR";

export function supervisorFromEnv(
  env: Record<string, string | undefined> = process.env
): ServiceSupervisorKind {
  const value = env[SERVICE_SUPERVISOR_ENV];
  return SUPERVISOR_KINDS.includes(value as ServiceSupervisorKind)
    ? (value as ServiceSupervisorKind)
    : "detached";
}

export type ServiceRecord = {
  product: string;
  owner: string;
  kind: string;
  pid: number;
  url: string;
  port: number;
  startedAt: string;
  authToken?: string;
  /** Version of the CLI that started the daemon; enables upgrade skew checks. */
  version?: string;
  /** Entry script the daemon was launched from (`process.argv[1]`). */
  binPath?: string;
  /** CLI arguments after the entry script; enables restart/upgrade respawns. */
  args?: readonly string[];
  /** Working directory the daemon runs in (project config discovery). */
  cwd?: string;
  supervisor?: ServiceSupervisorKind;
  /** Monotonic authority generation used by singleton control daemons. */
  generation?: number;
  /** Version of the private control protocol spoken by the daemon. */
  protocolVersion?: string;
  /** Random bearer credential for the private loopback control listener. */
  controlToken?: string;
  /** Public/data-plane URL exposed by a combined daemon. */
  dataUrl?: string;
  /** Data-plane port exposed by a combined daemon. */
  dataPort?: number;
  /** Public listener bind host. */
  host?: string;
  /** Whether the stable portless route is enabled. */
  portless?: boolean;
  /** Configured graceful-drain window. */
  drainGraceMs?: number;
  /** Private file containing the data-plane bearer token. */
  authTokenFile?: string;
  /** OS process birth identity used to reject PID reuse. */
  processIdentity?: string;
};

export type ServiceRecordInput = Omit<ServiceRecord, "product" | "owner">;

export type ServiceRecordStore = {
  directory: string;
  path(kind: string): string;
  /** Read a record; reaps and returns undefined when its pid is gone. */
  read(kind: string): ServiceRecord | undefined;
  write(record: ServiceRecordInput): ServiceRecord;
  /**
   * Remove a record. With `ifPid`, only remove when the stored pid matches —
   * a replaced daemon shutting down must not delete its successor's record.
   */
  remove(kind: string, options?: { ifPid?: number }): void;
};

export function processIdentity(pid: number): string | undefined {
  if (process.platform === "linux") try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).split(" ");
    return fields[19];
  } catch {
    return undefined;
  }
  if (process.platform === "darwin") {
    const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8"
    });
    const started = result.status === 0 ? result.stdout.trim() : "";
    return started.length > 0 ? started : undefined;
  }
  return undefined;
}

export function processAlive(pid: number, identity?: string): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    // EPERM: the pid exists but belongs to another user. After a reboot the
    // pid may have been reused by a system process, so the birth-identity
    // check below must still run before declaring the service alive.
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  return identity === undefined || processIdentity(pid) === identity;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalArgs(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? (value as string[])
    : undefined;
}

export function createServiceRecordStore(input: {
  home: string;
  product: string;
  owner?: string;
}): ServiceRecordStore {
  const owner = input.owner ?? input.product;
  const directory = join(input.home, "services");
  const path = (kind: string): string => join(directory, `${kind}.json`);

  const readRaw = (kind: string): ServiceRecord | undefined => {
    const file = path(kind);
    if (!existsSync(file)) return undefined;
    let parsed: Partial<ServiceRecord>;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ServiceRecord>;
    } catch {
      return undefined;
    }
    if (
      parsed.product !== input.product ||
      parsed.owner !== owner ||
      parsed.kind !== kind ||
      typeof parsed.pid !== "number" ||
      typeof parsed.url !== "string" ||
      typeof parsed.port !== "number" ||
      typeof parsed.startedAt !== "string"
    ) {
      return undefined;
    }
    const supervisor = SUPERVISOR_KINDS.includes(parsed.supervisor as ServiceSupervisorKind)
      ? (parsed.supervisor as ServiceSupervisorKind)
      : undefined;
    return {
      product: input.product,
      owner,
      kind,
      pid: parsed.pid,
      url: parsed.url,
      port: parsed.port,
      startedAt: parsed.startedAt,
      ...(optionalString(parsed.authToken) !== undefined ? { authToken: parsed.authToken as string } : {}),
      ...(optionalString(parsed.version) !== undefined ? { version: parsed.version as string } : {}),
      ...(optionalString(parsed.binPath) !== undefined ? { binPath: parsed.binPath as string } : {}),
      ...(optionalArgs(parsed.args) !== undefined ? { args: optionalArgs(parsed.args) } : {}),
      ...(optionalString(parsed.cwd) !== undefined ? { cwd: parsed.cwd as string } : {}),
      ...(supervisor !== undefined ? { supervisor } : {}),
      ...(typeof parsed.generation === "number" && Number.isSafeInteger(parsed.generation)
        ? { generation: parsed.generation }
        : {}),
      ...(optionalString(parsed.protocolVersion) !== undefined
        ? { protocolVersion: parsed.protocolVersion as string }
        : {}),
      ...(optionalString(parsed.controlToken) !== undefined
        ? { controlToken: parsed.controlToken as string }
        : {}),
      ...(optionalString(parsed.dataUrl) !== undefined
        ? { dataUrl: parsed.dataUrl as string }
        : {}),
      ...(typeof parsed.dataPort === "number" ? { dataPort: parsed.dataPort } : {}),
      ...(optionalString(parsed.host) !== undefined ? { host: parsed.host as string } : {}),
      ...(typeof parsed.portless === "boolean" ? { portless: parsed.portless } : {}),
      ...(typeof parsed.drainGraceMs === "number" ? { drainGraceMs: parsed.drainGraceMs } : {}),
      ...(optionalString(parsed.authTokenFile) !== undefined
        ? { authTokenFile: parsed.authTokenFile as string }
        : {}),
      ...(optionalString(parsed.processIdentity) !== undefined
        ? { processIdentity: parsed.processIdentity as string }
        : {})
    };
  };

  return {
    directory,
    path,
    read(kind) {
      const record = readRaw(kind);
      if (record === undefined) return undefined;
      if (!processAlive(record.pid, record.processIdentity)) return undefined;
      return record;
    },
    write(record) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      const full: ServiceRecord = { product: input.product, owner, ...record };
      writeFileAtomic(path(record.kind), `${JSON.stringify(full, null, 2)}\n`, { mode: 0o600 });
      chmodSync(path(record.kind), 0o600);
      return full;
    },
    remove(kind, options = {}) {
      if (options.ifPid !== undefined) {
        const record = readRaw(kind);
        if (record !== undefined && record.pid !== options.ifPid) return;
        // A guarded caller cannot safely unlink with a compare-then-delete:
        // a successor may atomically publish between those operations. Leave
        // the matching record in place; once this process exits, reads treat
        // it as stale and the successor overwrites it under lifecycle lock.
        return;
      }
      rmSync(path(kind), { force: true });
    }
  };
}
