import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  createPortlessSession,
  reapPortlessProject,
  reapPortlessService,
  writeFileAtomic
} from "@routekit/runtime";
import type { PortlessOptions, PortlessSession } from "@routekit/runtime";

import { routekitHome } from "./config.js";

export type ServiceKind = "gateway" | "accounts";

export type RouteKitServiceRecord = {
  product: "routekit";
  owner: "routekit";
  kind: ServiceKind;
  pid: number;
  url: string;
  port: number;
  startedAt: string;
  authToken?: string;
};

function serviceDirectory(): string {
  return join(routekitHome(), "services");
}

function servicePath(kind: ServiceKind): string {
  return join(serviceDirectory(), `${kind}.json`);
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readServiceRecord(kind: ServiceKind): RouteKitServiceRecord | undefined {
  const path = servicePath(kind);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RouteKitServiceRecord>;
    if (
      parsed.product !== "routekit" ||
      parsed.owner !== "routekit" ||
      parsed.kind !== kind ||
      typeof parsed.pid !== "number" ||
      typeof parsed.url !== "string" ||
      typeof parsed.port !== "number" ||
      typeof parsed.startedAt !== "string"
    ) {
      return undefined;
    }
    if (!alive(parsed.pid)) {
      rmSync(path, { force: true });
      return undefined;
    }
    return parsed as RouteKitServiceRecord;
  } catch {
    return undefined;
  }
}

function writeServiceRecord(record: RouteKitServiceRecord): void {
  mkdirSync(serviceDirectory(), { recursive: true, mode: 0o700 });
  chmodSync(serviceDirectory(), 0o700);
  writeFileAtomic(servicePath(record.kind), `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o600
  });
  chmodSync(servicePath(record.kind), 0o600);
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
  writeServiceRecord({
    product: "routekit",
    owner: "routekit",
    kind: input.kind,
    pid: process.pid,
    url,
    port: input.port,
    startedAt: new Date().toISOString(),
    ...(input.authToken !== undefined ? { authToken: input.authToken } : {})
  });
  return {
    url,
    release: async () => {
      if (session.enabled) session.unregister(name);
      rmSync(servicePath(input.kind), { force: true });
    }
  };
}

export type StopServiceResult = {
  kind: ServiceKind;
  stopped: boolean;
  stale?: boolean;
  pid?: number;
};

export async function stopService(
  kind: ServiceKind,
  log?: (line: string) => void
): Promise<StopServiceResult> {
  const record = readServiceRecord(kind);
  const reaped = await reapPortlessService(kind, portlessOptions(log));
  if (record === undefined) return { kind, stopped: reaped };
  let stopped = reaped;
  if (record.pid !== process.pid && alive(record.pid)) {
    try {
      process.kill(record.pid, "SIGTERM");
      stopped = true;
    } catch {
      // The process exited between the liveness probe and signal.
    }
  }
  rmSync(servicePath(kind), { force: true });
  return stopped
    ? { kind, stopped: true, pid: record.pid }
    : { kind, stopped: false, stale: true };
}

export async function stopAllServices(
  log?: (line: string) => void
): Promise<StopServiceResult[]> {
  const results = await Promise.all([
    stopService("gateway", log),
    stopService("accounts", log)
  ]);
  await reapPortlessProject(portlessOptions(log));
  return results;
}
