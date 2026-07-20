/**
 * Thin-client bootstrap for the singleton RouteKit daemon.
 *
 * Every product command uses `routekitClient`: discover the authoritative
 * daemon record, authenticate health + hello, and race-safely auto-start it
 * when absent. UI, terminal interaction, and local tool spawning stay outside
 * the daemon.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  findProjectRouterConfig,
  globalRouterConfigPath,
  routekitHome
} from "@routekit/config";
import { RouteKitControlClient } from "@routekit/control";
import {
  ControlClient,
  createServiceRecordStore,
  serviceLogPath,
  startDaemon
} from "@routekit/runtime";
import type { ServiceRecord, StartDaemonResult } from "@routekit/runtime";

import { routekitVersion } from "./state.js";

const PRODUCT = "routekit";
const KIND = "daemon";
const START_TIMEOUT_MS = 90_000;

export function daemonStore() {
  return createServiceRecordStore({ home: routekitHome(), product: PRODUCT });
}

export function readDaemonRecord(): ServiceRecord | undefined {
  return daemonStore().read(KIND);
}

export function controlClientForRecord(record: ServiceRecord): RouteKitControlClient {
  if (record.controlToken === undefined) {
    throw new Error("RouteKit daemon record has no control credential");
  }
  return new RouteKitControlClient({
    url: record.url,
    token: record.controlToken,
    packageVersion: routekitVersion(),
    cwd: process.cwd()
  });
}

export async function daemonRecordHealthy(record: ServiceRecord): Promise<boolean> {
  if (record.controlToken === undefined) return false;
  try {
    const client = new ControlClient({
      url: record.url,
      token: record.controlToken,
      timeoutMs: 1_500
    });
    await client.health();
    return true;
  } catch {
    return false;
  }
}

export function canonicalConfigOrMigrationError(): string {
  const global = globalRouterConfigPath();
  if (existsSync(global)) return global;
  const project = findProjectRouterConfig();
  if (project !== undefined) {
    throw new Error(
      `the singleton RouteKit daemon uses the canonical global config ${global}; ` +
        `import this project overlay explicitly with \`routekit config import --from ${project}\``
    );
  }
  throw new Error(
    `canonical router config not found: ${global}; run \`routekit config init --global\``
  );
}

export function daemonServeArgs(input: {
  configPath?: string;
  port?: number;
  authToken?: string;
  portless?: boolean;
  drainGraceMs?: number;
} = {}): string[] {
  return [
    "daemon",
    "run",
    "--config-path",
    input.configPath ?? canonicalConfigOrMigrationError(),
    "--port",
    String(input.port ?? 8080),
    ...(input.authToken !== undefined ? ["--auth-token", input.authToken] : []),
    ...(input.portless === false ? ["--no-portless"] : []),
    ...(input.drainGraceMs !== undefined
      ? ["--drain-grace-ms", String(input.drainGraceMs)]
      : [])
  ];
}

export async function ensureDaemon(input: {
  configPath?: string;
  port?: number;
  authToken?: string;
  portless?: boolean;
  drainGraceMs?: number;
} = {}): Promise<{
  client: RouteKitControlClient;
  record: ServiceRecord;
  start?: StartDaemonResult;
}> {
  const current = readDaemonRecord();
  if (current !== undefined && (await daemonRecordHealthy(current))) {
    const client = controlClientForRecord(current);
    await client.hello();
    return { client, record: current };
  }
  if (current !== undefined) {
    throw new Error(
      `RouteKit daemon pid ${current.pid} is alive but unhealthy; ` +
        "run `routekit daemon stop --force` before recovery"
    );
  }
  const entry = process.argv[1];
  if (entry === undefined) throw new Error("cannot resolve the routekit entry script");
  const home = routekitHome();
  const start = await startDaemon(
    {
      product: PRODUCT,
      kind: KIND,
      home,
      version: routekitVersion(),
      command: {
        execPath: process.execPath,
        args: [entry, ...daemonServeArgs(input)]
      },
      cwd: process.cwd()
    },
    {
      readyTimeoutMs: START_TIMEOUT_MS,
      ready: daemonRecordHealthy
    }
  );
  const client = controlClientForRecord(start.record);
  await client.hello();
  return { client, record: start.record, start };
}

export async function routekitClient(): Promise<RouteKitControlClient> {
  return (await ensureDaemon()).client;
}

export function daemonLogPath(): string {
  return serviceLogPath(routekitHome(), KIND);
}

export function daemonLifecycleLockPath(): string {
  return join(routekitHome(), "services", "daemon.lock");
}

