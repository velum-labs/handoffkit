import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { readPackageVersion } from "@routekit/cli-core";
import {
  createPortlessSession,
  createServiceRecordStore,
  processAlive,
  reapPortlessService,
  stopDaemonProcess,
  supervisorController,
  supervisorFromEnv,
  writeFileAtomic
} from "@routekit/runtime";
import type {
  PortlessOptions,
  PortlessSession,
  ServiceRecord,
  ServiceRecordStore
} from "@routekit/runtime";

import { routekitHome } from "./config.js";

export type ServiceKind = "gateway" | "accounts";

export type RouteKitServiceRecord = ServiceRecord & {
  product: "routekit";
  owner: "routekit";
  kind: ServiceKind;
};

export function routekitVersion(): string {
  return readPackageVersion(import.meta.url);
}

function store(): ServiceRecordStore {
  return createServiceRecordStore({ home: routekitHome(), product: "routekit" });
}

export function writeStateSnapshot(
  category: "catalog" | "health",
  name: string,
  value: unknown
): string {
  if (!/^[a-z0-9-]+$/i.test(name)) throw new Error(`invalid state snapshot name: ${name}`);
  const directory = join(routekitHome(), category);
  const path = join(directory, `${name}.json`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function readStateSnapshot(
  category: "catalog" | "health",
  name: string
): unknown {
  if (!/^[a-z0-9-]+$/i.test(name)) {
    throw new Error(`invalid state snapshot name: ${name}`);
  }
  const path = join(routekitHome(), category, `${name}.json`);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function portlessOptions(log?: (line: string) => void): PortlessOptions {
  return {
    project: "routekit",
    ownerLabel: "routekit",
    bareNames: [],
    ...(log !== undefined ? { log } : {})
  };
}

export function readServiceRecord(kind: ServiceKind): RouteKitServiceRecord | undefined {
  return store().read(kind) as RouteKitServiceRecord | undefined;
}

export type ServiceRegistration = {
  url: string;
  release(): Promise<void>;
};

export async function registerService(input: {
  kind: ServiceKind;
  loopbackUrl: string;
  port: number;
  authToken?: string;
  portless?: boolean;
  log?: (line: string) => void;
}): Promise<ServiceRegistration> {
  const session: PortlessSession = await createPortlessSession(
    input.portless ?? process.env.ROUTEKIT_PORTLESS !== "0",
    portlessOptions(input.log)
  );
  const name = input.kind;
  const url = session.enabled ? session.register(name, input.port) : input.loopbackUrl;
  const records = store();
  records.write({
    kind: input.kind,
    pid: process.pid,
    url,
    port: input.port,
    startedAt: new Date().toISOString(),
    version: routekitVersion(),
    supervisor: supervisorFromEnv(),
    ...(process.argv[1] !== undefined ? { binPath: process.argv[1] } : {}),
    args: process.argv.slice(2),
    cwd: process.cwd(),
    ...(input.authToken !== undefined ? { authToken: input.authToken } : {})
  });
  return {
    url,
    release: async () => {
      if (session.enabled) session.unregister(name);
      // pid-guarded: a blue-green replacement writes its own record before
      // this (old) process shuts down, and that record must survive.
      records.remove(input.kind, { ifPid: process.pid });
    }
  };
}

export type StopServiceResult = {
  kind: ServiceKind;
  stopped: boolean;
  stale?: boolean;
  pid?: number;
  supervisor?: RouteKitServiceRecord["supervisor"];
};

/**
 * Stop a RouteKit service. Supervised processes (systemd/launchd) are stopped
 * through their supervisor — a raw SIGTERM would just be restarted — while
 * detached daemons get SIGTERM plus a wait that covers the drain window.
 */
export async function stopService(
  kind: ServiceKind,
  options: { graceMs?: number; log?: (line: string) => void } = {}
): Promise<StopServiceResult> {
  const record = readServiceRecord(kind);
  const reaped = await reapPortlessService(kind, portlessOptions(options.log));
  if (record === undefined) {
    store().remove(kind);
    return { kind, stopped: reaped };
  }
  let stopped = reaped;
  if (record.supervisor === "systemd" || record.supervisor === "launchd") {
    const controller = supervisorController(record.supervisor, "routekit", kind);
    await controller.stop();
    stopped = true;
  } else if (record.pid !== process.pid && processAlive(record.pid)) {
    const result = await stopDaemonProcess(record, {
      ...(options.graceMs !== undefined ? { graceMs: options.graceMs } : {})
    });
    stopped = stopped || result.stopped;
  }
  store().remove(kind);
  return stopped
    ? {
        kind,
        stopped: true,
        pid: record.pid,
        ...(record.supervisor !== undefined ? { supervisor: record.supervisor } : {})
      }
    : { kind, stopped: false, stale: true };
}
