import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type RouteMapping = { hostname: string; port: number; pid: number };
export type RouteStoreLike = {
  addRoute(hostname: string, port: number, pid: number, force?: boolean): number | undefined;
  removeRoute(hostname: string, ownerPid?: number): void;
  loadRoutes(persistCleanup?: boolean): RouteMapping[];
};
export type PortlessModule = {
  RouteStore: new (dir: string, options?: { onWarning?: (message: string) => void }) => RouteStoreLike;
  parseHostname: (input: string, tld?: string) => string;
  formatUrl: (hostname: string, proxyPort: number, tls?: boolean) => string;
};

export type PortlessOptions = {
  project: string;
  ownerLabel: string;
  bareNames?: readonly string[];
  stateDirectory?: string;
  tld?: string;
  proxyProbeTimeoutMs?: number;
  staleShutdownTimeoutMs?: number;
  loadModule?: () => Promise<PortlessModule | undefined>;
  log?: (line: string) => void;
};

export type DetectedProxy = { port: number; tls: boolean };
export type SpawnedService = {
  port: number;
  pid?: number;
  close: () => Promise<void> | void;
};
export type DiscoverOrSpawnInput = {
  name: string;
  identity: string;
  healthCheck: (loopbackUrl: string) => Promise<string | undefined>;
  replaceStale?: boolean;
  spawn: () => Promise<SpawnedService>;
};
export type DiscoverOrSpawnResult = {
  url: string;
  loopbackUrl: string;
  port: number;
  owned: boolean;
  close: () => Promise<void> | void;
};
export type PortlessSession = {
  enabled: boolean;
  caCertPath: string | undefined;
  register(name: string, appPort: number): string;
  unregister(name: string): void;
  discoverOrSpawn(input: DiscoverOrSpawnInput): Promise<DiscoverOrSpawnResult>;
};

const loopback = (port: number): string => `http://127.0.0.1:${port}`;

function stateDirectory(options: PortlessOptions): string {
  return options.stateDirectory ?? process.env.PORTLESS_STATE_DIR ?? join(homedir(), ".portless");
}

function routeTld(options: PortlessOptions): string {
  return options.tld ?? process.env.PORTLESS_TLD ?? "localhost";
}

function log(options: PortlessOptions, message: string): void {
  options.log?.(`${options.ownerLabel}: ${message}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function defaultLoadModule(): Promise<PortlessModule | undefined> {
  // `portless` is optional and currently requires a newer Node runtime. A
  // variable dynamic specifier keeps this package installable without it.
  const specifier = "portless";
  try {
    return (await import(specifier)) as unknown as PortlessModule;
  } catch {
    return undefined;
  }
}

export async function detectPortlessProxy(
  options: Pick<PortlessOptions, "stateDirectory" | "proxyProbeTimeoutMs"> = {}
): Promise<DetectedProxy | undefined> {
  const directory =
    options.stateDirectory ?? process.env.PORTLESS_STATE_DIR ?? join(homedir(), ".portless");
  const portFile = join(directory, "proxy.port");
  if (!existsSync(portFile)) return undefined;
  const port = Number.parseInt(readFileSync(portFile, "utf8").trim(), 10);
  if (!Number.isInteger(port) || port <= 0) return undefined;

  const pidFile = join(directory, "proxy.pid");
  if (existsSync(pidFile)) {
    const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    if (Number.isInteger(pid) && pid > 0 && !isAlive(pid)) return undefined;
  }

  const tlsFile = join(directory, "proxy.tls");
  const tlsFromFile = existsSync(tlsFile)
    ? ["1", "true"].includes(readFileSync(tlsFile, "utf8").trim().toLowerCase())
    : undefined;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      redirect: "manual",
      signal: AbortSignal.timeout(options.proxyProbeTimeoutMs ?? 1_500)
    });
    if (response.headers.get("x-portless") === null) return undefined;
    const location = response.headers.get("location");
    return {
      port,
      tls: tlsFromFile ?? (port === 443 || location?.startsWith("https://") === true)
    };
  } catch {
    return undefined;
  }
}

function hostnameFor(portless: PortlessModule, options: PortlessOptions, name: string): string {
  const bare = new Set(options.bareNames ?? []);
  const full =
    name === options.project || name.includes(".") || bare.has(name)
      ? name
      : `${name}.${options.project}`;
  return portless.parseHostname(full, routeTld(options));
}

function disabledSession(): PortlessSession {
  return {
    enabled: false,
    caCertPath: undefined,
    register: (_name, port) => loopback(port),
    unregister: () => {},
    discoverOrSpawn: async (input) => {
      const service = await input.spawn();
      const url = loopback(service.port);
      return { url, loopbackUrl: url, port: service.port, owned: true, close: service.close };
    }
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isAlive(pid)) return true;
    await delay(50);
  }
  return !isAlive(pid);
}

async function replaceStaleRoute(
  store: RouteStoreLike,
  hostname: string,
  route: RouteMapping,
  options: PortlessOptions
): Promise<void> {
  try {
    if (route.pid !== process.pid) {
      process.kill(route.pid, "SIGTERM");
      log(options, `stopped stale ${hostname} (pid ${route.pid})`);
      if (!(await waitForExit(route.pid, options.staleShutdownTimeoutMs ?? 2_000))) {
        log(options, `stale ${hostname} pid ${route.pid} did not exit before restart`);
      }
    }
  } catch {
    // Already gone or not owned by this user; remove the stale route anyway.
  }
  try {
    store.removeRoute(hostname);
  } catch {
    // best-effort
  }
}

export function createActivePortlessSession(
  portless: PortlessModule,
  proxy: DetectedProxy,
  options: PortlessOptions
): PortlessSession {
  const store = new portless.RouteStore(stateDirectory(options), {
    onWarning: (message) => log(options, `portless: ${message}`)
  });
  const urlFor = (hostname: string): string => portless.formatUrl(hostname, proxy.port, proxy.tls);
  const register = (name: string, appPort: number): string => {
    try {
      const hostname = hostnameFor(portless, options, name);
      store.addRoute(hostname, appPort, process.pid, true);
      return urlFor(hostname);
    } catch (error) {
      log(options, `portless register(${name}) failed: ${errorText(error)}`);
      return loopback(appPort);
    }
  };
  const unregister = (name: string): void => {
    try {
      store.removeRoute(hostnameFor(portless, options, name), process.pid);
    } catch {
      // best-effort
    }
  };
  const discoverOrSpawn = async (
    input: DiscoverOrSpawnInput
  ): Promise<DiscoverOrSpawnResult> => {
    const hostname = hostnameFor(portless, options, input.name);
    let stale: RouteMapping | undefined;
    try {
      const existing = store.loadRoutes().find((route) => route.hostname === hostname);
      if (existing !== undefined) {
        const candidate = loopback(existing.port);
        if ((await input.healthCheck(candidate)) === input.identity) {
          return {
            url: urlFor(hostname),
            loopbackUrl: candidate,
            port: existing.port,
            owned: false,
            close: () => {}
          };
        }
        stale = existing;
      }
    } catch (error) {
      log(options, `portless discover(${input.name}) failed: ${errorText(error)}`);
    }
    if (stale !== undefined && input.replaceStale === true) {
      await replaceStaleRoute(store, hostname, stale, options);
    }
    const service = await input.spawn();
    let url = loopback(service.port);
    try {
      store.addRoute(hostname, service.port, service.pid ?? process.pid, true);
      url = urlFor(hostname);
    } catch (error) {
      log(options, `portless register(${input.name}) failed: ${errorText(error)}`);
    }
    return {
      url,
      loopbackUrl: loopback(service.port),
      port: service.port,
      owned: true,
      close: service.close
    };
  };
  return {
    enabled: true,
    caCertPath: join(stateDirectory(options), "ca.pem"),
    register,
    unregister,
    discoverOrSpawn
  };
}

export async function createPortlessSession(
  enabled: boolean,
  options: PortlessOptions
): Promise<PortlessSession> {
  if (!enabled) return disabledSession();
  const portless = await (options.loadModule ?? defaultLoadModule)();
  if (portless === undefined) {
    log(options, "portless not installed; using loopback URLs");
    return disabledSession();
  }
  const proxy = await detectPortlessProxy({
    stateDirectory: stateDirectory(options),
    proxyProbeTimeoutMs: options.proxyProbeTimeoutMs
  });
  if (proxy === undefined) {
    log(
      options,
      "portless proxy not running; using loopback URLs " +
        "(run `portless service install` + `portless trust` for stable local names)"
    );
    return disabledSession();
  }
  return createActivePortlessSession(portless, proxy, options);
}

export async function reapPortlessService(
  name: string,
  options: PortlessOptions
): Promise<boolean> {
  const portless = await (options.loadModule ?? defaultLoadModule)();
  if (portless === undefined) return false;
  const store = new portless.RouteStore(stateDirectory(options), {
    onWarning: (message) => log(options, `portless: ${message}`)
  });
  const hostname = hostnameFor(portless, options, name);
  const route = store.loadRoutes().find((candidate) => candidate.hostname === hostname);
  if (route === undefined) return false;
  let stopped = false;
  try {
    process.kill(route.pid, "SIGTERM");
    stopped = true;
    log(options, `stopped ${route.hostname} (pid ${route.pid})`);
  } catch {
    // already gone
  }
  try {
    store.removeRoute(route.hostname);
  } catch {
    // best-effort
  }
  return stopped;
}

export async function reapPortlessProject(options: PortlessOptions): Promise<number> {
  const portless = await (options.loadModule ?? defaultLoadModule)();
  if (portless === undefined) return 0;
  const store = new portless.RouteStore(stateDirectory(options), {
    onWarning: (message) => log(options, `portless: ${message}`)
  });
  const suffix = `.${options.project}.${routeTld(options)}`;
  const bareHosts = new Set(
    (options.bareNames ?? []).map((name) => portless.parseHostname(name, routeTld(options)))
  );
  let stopped = 0;
  for (const route of store.loadRoutes()) {
    if (!route.hostname.endsWith(suffix) && !bareHosts.has(route.hostname)) continue;
    try {
      process.kill(route.pid, "SIGTERM");
      stopped += 1;
      log(options, `stopped ${route.hostname} (pid ${route.pid})`);
    } catch {
      // already gone
    }
    try {
      store.removeRoute(route.hostname);
    } catch {
      // best-effort
    }
  }
  return stopped;
}
