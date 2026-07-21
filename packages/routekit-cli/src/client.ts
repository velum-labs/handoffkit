/**
 * Thin-client bootstrap for the singleton RouteKit daemon.
 *
 * Every product command uses `routekitClient`: discover the authoritative
 * daemon record, authenticate health + hello, and race-safely auto-start it
 * when absent. UI, terminal interaction, and local tool spawning stay outside
 * the daemon.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  findProjectRouterConfig,
  globalRouterConfigPath,
  loadRouterConfig,
  routekitHome
} from "@routekit/config";
import { RouteKitControlClient } from "@routekit/control";
import {
  acquireLifecycleLock,
  ControlClient,
  createServiceRecordStore,
  detectSupervisor,
  generateControlToken,
  serviceLogPath,
  startDaemon,
  stopDaemonProcess,
  supervisorController,
  supervisorOperationTimeoutMs,
  waitForServiceReady,
  writeFileAtomic
} from "@routekit/runtime";
import type { ServiceRecord, StartDaemonResult } from "@routekit/runtime";

import { routekitVersion } from "./state.js";
import { daemonUnitSpec, serviceEnvironment } from "./daemon.js";

const PRODUCT = "routekit";
const KIND = "daemon";
const START_TIMEOUT_MS = 90_000;

function defaultDaemonPort(): number {
  const raw = process.env.ROUTEKIT_DAEMON_PORT;
  if (raw === undefined) return 8080;
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("ROUTEKIT_DAEMON_PORT must be an integer between 0 and 65535");
  }
  return port;
}
export function daemonDataTokenPath(): string {
  return join(routekitHome(), "secrets", "data-token");
}

export function ensureDaemonDataToken(authToken?: string): string {
  const path = daemonDataTokenPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token =
    authToken ??
    (existsSync(path) ? readFileSync(path, "utf8").trim() : generateControlToken());
  if (token.length === 0) throw new Error("RouteKit data-plane token is empty");
  writeFileAtomic(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function daemonStore() {
  return createServiceRecordStore({ home: routekitHome(), product: PRODUCT });
}

export function readDaemonRecord(): ServiceRecord | undefined {
  return daemonStore().read(KIND);
}

async function retireLegacyGateway(): Promise<void> {
  const store = daemonStore();
  const legacy = store.read("gateway");
  if (legacy === undefined) return;
  const lock = await acquireLifecycleLock(daemonLifecycleLockPath());
  try {
    const current = store.read("gateway");
    if (current === undefined) return;
    if (current.supervisor === "systemd" || current.supervisor === "launchd") {
      await supervisorController(
        current.supervisor,
        PRODUCT,
        "gateway"
      ).uninstall({
        timeoutMs: supervisorOperationTimeoutMs(current.drainGraceMs)
      });
    } else {
      await stopDaemonProcess(current, {
        graceMs: supervisorOperationTimeoutMs(current.drainGraceMs)
      });
    }
    store.remove("gateway");
  } finally {
    lock.release();
  }
}

export function controlClientForRecord(record: ServiceRecord): RouteKitControlClient {
  if (record.controlToken === undefined) {
    throw new Error("RouteKit daemon record has no control credential");
  }
  return new RouteKitControlClient({
    url: record.url,
    token: record.controlToken,
    packageVersion: routekitVersion(),
    cwd: process.cwd(),
    timeoutMs: (record.drainGraceMs ?? 30_000) * 2 + 30_000
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
  if (
    (process.env.ROUTEKIT_CONFIG ?? "").length > 0 ||
    process.argv.includes("--config") ||
    process.argv.some((argument) => argument.startsWith("--config="))
  ) {
    throw new Error(
      "--config / ROUTEKIT_CONFIG are not supported by singleton daemon operations; " +
        "use `routekit config import --from <path>`"
    );
  }
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
  host?: string;
  port?: number;
  authTokenFile?: string;
  portless?: boolean;
  drainGraceMs?: number;
} = {}): string[] {
  return [
    "daemon",
    "run",
    "--config-path",
    input.configPath ?? canonicalConfigOrMigrationError(),
    "--host",
    input.host ?? "127.0.0.1",
    "--port",
    String(input.port ?? defaultDaemonPort()),
    ...(input.authTokenFile !== undefined
      ? ["--auth-token-file", input.authTokenFile]
      : []),
    ...(input.portless === false ? ["--no-portless"] : []),
    ...(input.drainGraceMs !== undefined
      ? ["--drain-grace-ms", String(input.drainGraceMs)]
      : [])
  ];
}

export async function ensureDaemon(input: {
  configPath?: string;
  host?: string;
  port?: number;
  authToken?: string;
  portless?: boolean;
  drainGraceMs?: number;
} = {}): Promise<{
  client: RouteKitControlClient;
  record: ServiceRecord;
  start?: StartDaemonResult;
}> {
  const requestedConfigPath = input.configPath ?? canonicalConfigOrMigrationError();
  await retireLegacyGateway();
  const current = readDaemonRecord();
  if (current !== undefined && (await daemonRecordHealthy(current))) {
    if (
      input.authToken !== undefined &&
      current.authTokenFile !== undefined &&
      readFileSync(current.authTokenFile, "utf8").trim() !== input.authToken
    ) {
      throw new Error(
        "RouteKit daemon is already running with a different data-plane token; restart it to rotate credentials"
      );
    }
    if (
      (input.host !== undefined && current.host !== input.host) ||
      (input.port !== undefined &&
        input.port !== 0 &&
        current.dataPort !== input.port) ||
      (input.portless !== undefined && current.portless !== input.portless) ||
      (input.drainGraceMs !== undefined &&
        current.drainGraceMs !== input.drainGraceMs)
    ) {
      throw new Error(
        "RouteKit daemon is already running with different listener/lifecycle options; " +
          "restart it with the requested configuration"
      );
    }
    if (current.version !== undefined && current.version !== routekitVersion()) {
      const entry = process.argv[1];
      if (
        (current.supervisor === "systemd" || current.supervisor === "launchd") &&
        current.binPath !== undefined &&
        entry !== undefined &&
        current.binPath !== entry
      ) {
        throw new Error(
          `the singleton daemon runs ${current.binPath}, but this CLI is ${entry}; ` +
            "run `routekit daemon service install` to rewrite the unit"
        );
      }
      const lock = await acquireLifecycleLock(daemonLifecycleLockPath());
      try {
        // Re-read under the lock: another client may already have upgraded it.
        const authoritative = readDaemonRecord();
        if (
          authoritative !== undefined &&
          authoritative.version !== routekitVersion()
        ) {
          if (
            authoritative.supervisor === "systemd" ||
            authoritative.supervisor === "launchd"
          ) {
            const timeoutMs = supervisorOperationTimeoutMs(
              authoritative.drainGraceMs
            );
            await supervisorController(
              authoritative.supervisor,
              PRODUCT,
              KIND
            ).restart({ timeoutMs });
            const replacement = await waitForServiceReady({
              home: routekitHome(),
              product: PRODUCT,
              kind: KIND,
              previousPid: authoritative.pid,
              timeoutMs,
              logFile: daemonLogPath(),
              ready: daemonRecordHealthy
            });
            const client = controlClientForRecord(replacement);
            await client.hello();
            return { client, record: replacement };
          }
          await stopDaemonProcess(authoritative, {
            graceMs: supervisorOperationTimeoutMs(authoritative.drainGraceMs)
          });
        }
      } finally {
        lock.release();
      }
      // Detached daemon: fall through to the ordinary race-safe start after
      // the old generation has drained and removed its record.
      return await ensureDaemon({
        ...input,
        port: input.port ?? current.dataPort ?? 8080,
        ...(input.authToken !== undefined
          ? { authToken: input.authToken }
          : current.authToken !== undefined
            ? { authToken: current.authToken }
            : {})
      });
    }
    const client = controlClientForRecord(current);
    const hello = await client.hello();
    if (!hello.capabilities.includes("routekit.control.v1")) {
      throw new Error("RouteKit daemon does not advertise routekit.control.v1");
    }
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
  const authTokenFile = ensureDaemonDataToken(input.authToken);
  const configPath = requestedConfigPath;
  const supervisor = await detectSupervisor(PRODUCT, KIND);
  if (supervisor !== undefined) {
    const lock = await acquireLifecycleLock(daemonLifecycleLockPath(), {
      timeoutMs: START_TIMEOUT_MS
    });
    try {
      const joined = readDaemonRecord();
      if (joined !== undefined && (await daemonRecordHealthy(joined))) {
        const client = controlClientForRecord(joined);
        await client.hello();
        return { client, record: joined };
      }
      const graceMs = input.drainGraceMs ?? 30_000;
      const config = loadRouterConfig({ configPath }).config;
      let installed = false;
      try {
        await supervisor.install(
          daemonUnitSpec({
            args: daemonServeArgs({ ...input, configPath, authTokenFile }),
            supervisor: supervisor.kind,
            env: serviceEnvironment(config),
            drainGraceMs: graceMs
          })
        );
        installed = true;
        const record = await waitForServiceReady({
          home,
          product: PRODUCT,
          kind: KIND,
          timeoutMs: supervisorOperationTimeoutMs(graceMs),
          logFile: daemonLogPath(),
          ready: daemonRecordHealthy
        });
        const client = controlClientForRecord(record);
        await client.hello();
        return { client, record };
      } catch (error) {
        if (installed) {
          await supervisor
            .uninstall({ timeoutMs: supervisorOperationTimeoutMs(graceMs) })
            .catch(() => undefined);
        }
        throw error;
      }
    } finally {
      lock.release();
    }
  }
  const start = await startDaemon(
    {
      product: PRODUCT,
      kind: KIND,
      home,
      version: routekitVersion(),
      command: {
        execPath: process.execPath,
        args: [entry, ...daemonServeArgs({ ...input, configPath, authTokenFile })]
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

export async function connectDaemon(): Promise<
  { client: RouteKitControlClient; record: ServiceRecord } | undefined
> {
  const record = readDaemonRecord();
  if (record === undefined || !(await daemonRecordHealthy(record))) return undefined;
  const client = controlClientForRecord(record);
  await client.hello();
  return { client, record };
}

export function daemonLogPath(): string {
  return serviceLogPath(routekitHome(), KIND);
}

export function daemonLifecycleLockPath(): string {
  return join(routekitHome(), "services", "daemon.lock");
}
