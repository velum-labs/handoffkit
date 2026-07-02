/**
 * Programmatic portless integration for the fusion stack.
 *
 * Every dev server and CLI-spawned service the launcher starts is registered
 * with portless as a stable, named `.localhost` route, so humans and external
 * coding agents get clean HTTPS URLs instead of raw ports, and a service can be
 * discovered + reused across runs (a singleton) via the shared route table.
 *
 * Routes are managed entirely against the `portless` *library* (its exported
 * `RouteStore` writes the same file-locked `routes.json` the running proxy reads
 * live) — we never shell out to the `portless` binary. The privileged TLS proxy
 * daemon + CA trust are a one-time user setup (`portless service install` +
 * `portless trust`); here we only detect that it is running and register routes.
 *
 * `portless` requires Node >= 24 and is declared an optional dependency, so on
 * older Node (or when the package/proxy is absent) the session degrades to
 * plain loopback URLs with no discovery — identical code paths, just unproxied.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The npm scope-less project prefix for fusion service hostnames. */
const PROJECT = "fusion";

/** Minimal view of the bits of the `portless` library we use. */
type RouteMapping = { hostname: string; port: number; pid: number };
type RouteStoreLike = {
  addRoute(hostname: string, port: number, pid: number, force?: boolean): number | undefined;
  removeRoute(hostname: string, ownerPid?: number): void;
  loadRoutes(persistCleanup?: boolean): RouteMapping[];
};
type PortlessModule = {
  RouteStore: new (dir: string, options?: { onWarning?: (message: string) => void }) => RouteStoreLike;
  parseHostname: (input: string, tld?: string) => string;
  formatUrl: (hostname: string, proxyPort: number, tls?: boolean) => string;
};

/** Resolve the portless state directory (honoring `PORTLESS_STATE_DIR`). */
export function stateDir(): string {
  return process.env.PORTLESS_STATE_DIR ?? join(homedir(), ".portless");
}

/** Path to the portless CA, for `NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE`. */
export function caCertPath(): string {
  return join(stateDir(), "ca.pem");
}

/** The TLD portless serves routes under (default `.localhost`). */
export function tld(): string {
  return process.env.PORTLESS_TLD ?? "localhost";
}

/** A running portless proxy, as detected from on-disk state + a live probe. */
export type DetectedProxy = { port: number; tls: boolean };

/**
 * Detect a running portless proxy: read `<stateDir>/proxy.port`, confirm the
 * owning pid is alive, and probe the port for the `X-Portless` header (a plain
 * HTTP probe works even against a TLS proxy, which 302-redirects to https and
 * still stamps the header). Returns `undefined` when no proxy is reachable.
 */
export async function detectProxy(): Promise<DetectedProxy | undefined> {
  const dir = stateDir();
  const portFile = join(dir, "proxy.port");
  if (!existsSync(portFile)) return undefined;
  const port = Number.parseInt(readFileSync(portFile, "utf8").trim(), 10);
  if (!Number.isInteger(port) || port <= 0) return undefined;

  const pidFile = join(dir, "proxy.pid");
  if (existsSync(pidFile)) {
    const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    if (Number.isInteger(pid) && pid > 0 && !isAlive(pid)) return undefined;
  }

  // Prefer the proxy's recorded TLS mode; fall back to inferring it from the
  // redirect a plain-HTTP probe gets (a TLS proxy 302s to https).
  const tlsFile = join(dir, "proxy.tls");
  const tlsFromFile = existsSync(tlsFile)
    ? ["1", "true"].includes(readFileSync(tlsFile, "utf8").trim().toLowerCase())
    : undefined;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      redirect: "manual",
      signal: AbortSignal.timeout(1500)
    });
    if (response.headers.get("x-portless") === null) return undefined;
    const location = response.headers.get("location");
    const tls = tlsFromFile ?? (port === 443 || (location !== null && location.startsWith("https://")));
    return { port, tls };
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by another user (e.g. the
    // portless proxy installed as a root LaunchDaemon) — still alive. Only
    // ESRCH ("no such process") means it is actually gone.
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

async function loadPortless(): Promise<PortlessModule | undefined> {
  // Variable specifier + dynamic import: `portless` is an optional dependency
  // (Node >= 24 only), so this must not be a static import — it would break the
  // build/install on Node 22. Documented exception to the no-inline-imports rule.
  const specifier = "portless";
  try {
    return (await import(specifier)) as unknown as PortlessModule;
  } catch {
    return undefined;
  }
}

/** A service the launcher started, addressable through portless. */
export type SpawnedService = {
  port: number;
  /** Owning pid for the route (defaults to this process). */
  pid?: number;
  close: () => Promise<void> | void;
};

export type DiscoverOrSpawnInput = {
  /** Short service name; the `.fusion` project suffix + TLD are added here. */
  name: string;
  /** Expected identity token of a reusable instance (model set, config hash, ...). */
  identity: string;
  /** Probe a candidate instance on its loopback URL; return its identity token. */
  healthCheck: (loopbackUrl: string) => Promise<string | undefined>;
  /**
   * Terminate and remove an existing route whose health identity does not match.
   * Use only for singleton fixed-port services where a stale owner blocks spawn.
   */
  replaceStale?: boolean;
  /** Start a fresh instance when none can be reused. */
  spawn: () => Promise<SpawnedService>;
};

export type DiscoverOrSpawnResult = {
  /** The URL callers should surface/inject (portless name, or loopback). */
  url: string;
  /** The loopback URL for in-process CLI fetches (avoids the CA-at-startup hazard). */
  loopbackUrl: string;
  port: number;
  /** True when this run spawned the instance (and therefore owns teardown). */
  owned: boolean;
  /** Tear down only an owned instance; reused instances are left running. */
  close: () => Promise<void> | void;
};

/**
 * A live portless session threaded through the launcher. When `enabled` is
 * false (portless off, package absent, or no proxy detected) every method
 * degrades to plain loopback behavior with no proxy registration or discovery.
 */
export type PortlessSession = {
  enabled: boolean;
  /** Portless CA path when active, else undefined. */
  caCertPath: string | undefined;
  /** Register `127.0.0.1:<port>` under `<name>.<project>.localhost`; returns the URL. */
  register(name: string, appPort: number): string;
  /** Remove a route this process owns. */
  unregister(name: string): void;
  /** Reuse a compatible running instance, or spawn + register a new one. */
  discoverOrSpawn(input: DiscoverOrSpawnInput): Promise<DiscoverOrSpawnResult>;
};

export type CreateSessionInput = {
  /** Whether portless is requested (CLI flag / config / PORTLESS env). */
  enabled: boolean;
  log?: (line: string) => void;
};

/** Names that stay bare (`<name>.localhost`) instead of being namespaced under the project. */
const BARE_NAMES = new Set(["scope"]);

/** Map a short service name to its portless hostname. */
function hostnameFor(portless: PortlessModule, name: string): string {
  // `scope` stays bare (`scope.localhost`); everything else is namespaced under
  // the project (`gateway.fusion.localhost`). A name already containing a dot or
  // equal to the project is treated as an explicit subdomain path.
  const full =
    name === PROJECT || name.includes(".") || BARE_NAMES.has(name) ? name : `${name}.${PROJECT}`;
  return portless.parseHostname(full, tld());
}

const loopback = (port: number): string => `http://127.0.0.1:${port}`;

/** Build a disabled session: pure loopback, no proxy, no discovery. */
function disabledSession(): PortlessSession {
  return {
    enabled: false,
    caCertPath: undefined,
    register: (_name, appPort) => loopback(appPort),
    unregister: () => {},
    discoverOrSpawn: async (input) => {
      const service = await input.spawn();
      const url = loopback(service.port);
      return { url, loopbackUrl: url, port: service.port, owned: true, close: service.close };
    }
  };
}

/**
 * Create a portless session. Returns a disabled (loopback) session when
 * portless is off, the library is unavailable (Node < 24 / not installed), or
 * no proxy is running; otherwise an active session backed by `RouteStore`.
 */
export async function createPortlessSession(input: CreateSessionInput): Promise<PortlessSession> {
  if (!input.enabled) return disabledSession();
  const portless = await loadPortless();
  if (portless === undefined) {
    input.log?.("fusion: portless not installed (needs Node >= 24); using loopback URLs");
    return disabledSession();
  }
  const proxy = await detectProxy();
  if (proxy === undefined) {
    // Portless is installed but its proxy isn't running: degrade to loopback
    // (never block a run) and point the user at the one-time setup for stable
    // HTTPS names.
    input.log?.(
      "fusion: portless proxy not running; using loopback URLs " +
        "(run `portless service install` + `portless trust` for stable https://*.localhost names)"
    );
    return disabledSession();
  }

  const store = new portless.RouteStore(stateDir(), {
    onWarning: (message) => input.log?.(`fusion: portless: ${message}`)
  });

  const urlFor = (hostname: string): string => portless.formatUrl(hostname, proxy.port, proxy.tls);

  const register = (name: string, appPort: number): string => {
    try {
      const hostname = hostnameFor(portless, name);
      store.addRoute(hostname, appPort, process.pid, true);
      return urlFor(hostname);
    } catch (error) {
      // Never let a routing hiccup break a run; fall back to the raw port.
      input.log?.(`fusion: portless register(${name}) failed: ${errorText(error)}`);
      return loopback(appPort);
    }
  };

  const unregister = (name: string): void => {
    try {
      store.removeRoute(hostnameFor(portless, name), process.pid);
    } catch {
      // best-effort
    }
  };

  const discoverOrSpawn = async (req: DiscoverOrSpawnInput): Promise<DiscoverOrSpawnResult> => {
    const hostname = hostnameFor(portless, req.name);
    let staleRoute: RouteMapping | undefined;
    // Discover: is a compatible instance already registered and alive?
    try {
      const existing = store.loadRoutes().find((route) => route.hostname === hostname);
      if (existing !== undefined) {
        const candidate = loopback(existing.port);
        const identity = await req.healthCheck(candidate);
        if (identity === req.identity) {
          return {
            url: urlFor(hostname),
            loopbackUrl: candidate,
            port: existing.port,
            owned: false,
            close: () => {}
          };
        }
        staleRoute = existing;
      }
    } catch (error) {
      input.log?.(`fusion: portless discover(${req.name}) failed: ${errorText(error)}`);
    }
    if (staleRoute !== undefined && req.replaceStale === true) {
      await replaceStaleRoute(store, hostname, staleRoute, input.log);
    }
    // Spawn + register a fresh instance, owned by the service pid so the proxy's
    // liveness filter keeps the route across runs and only drops it when the
    // service itself exits.
    const service = await req.spawn();
    let url = loopback(service.port);
    try {
      store.addRoute(hostname, service.port, service.pid ?? process.pid, true);
      url = urlFor(hostname);
    } catch (error) {
      input.log?.(`fusion: portless register(${req.name}) failed: ${errorText(error)}`);
    }
    return {
      url,
      loopbackUrl: loopback(service.port),
      port: service.port,
      owned: true,
      close: service.close
    };
  };

  return { enabled: true, caCertPath: caCertPath(), register, unregister, discoverOrSpawn };
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
  log: ((line: string) => void) | undefined
): Promise<void> {
  try {
    if (route.pid !== process.pid) {
      process.kill(route.pid, "SIGTERM");
      log?.(`fusion: stopped stale ${hostname} (pid ${route.pid})`);
      if (!(await waitForExit(route.pid, 2_000))) {
        log?.(`fusion: stale ${hostname} pid ${route.pid} did not exit before restart`);
      }
    }
  } catch {
    // Process already gone or not ours; the route should still be removed.
  }
  try {
    store.removeRoute(hostname);
  } catch {
    // best-effort
  }
}

/**
 * Reap fusion singleton services: terminate the owning pid of every registered
 * `*.fusion.<tld>` / `scope.<tld>` route and drop the route. Returns the number
 * of services stopped. A no-op when portless is unavailable.
 */
export async function reapFusionServices(log?: (line: string) => void): Promise<number> {
  const portless = await loadPortless();
  if (portless === undefined) return 0;
  const store = new portless.RouteStore(stateDir(), {
    onWarning: (message) => log?.(`fusion: portless: ${message}`)
  });
  const suffix = `.${PROJECT}.${tld()}`;
  const scopeHost = portless.parseHostname("scope", tld());
  let stopped = 0;
  for (const route of store.loadRoutes()) {
    if (!route.hostname.endsWith(suffix) && route.hostname !== scopeHost) continue;
    try {
      process.kill(route.pid, "SIGTERM");
      stopped += 1;
      log?.(`fusion: stopped ${route.hostname} (pid ${route.pid})`);
    } catch {
      // process already gone; still drop the stale route below
    }
    try {
      store.removeRoute(route.hostname);
    } catch {
      // best-effort
    }
  }
  return stopped;
}
