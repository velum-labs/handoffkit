import {
  CLIPROXY_API_KEY_ENV,
  cliproxyApiKey,
  openSubscriptionRelays
} from "@routekit/accounts";
import type { SubscriptionAccountConfigs } from "@routekit/accounts";
import { CatalogBackend, startGateway } from "@routekit/gateway";
import type { Gateway, RouterConfig } from "@routekit/gateway";
import { registerCleanup } from "@routekit/runtime";

import { registerService } from "./state.js";
import type { ServiceRegistration } from "./state.js";

export type RouterServeOptions = {
  config: RouterConfig;
  host?: string;
  port?: number;
  authToken?: string;
  portless?: boolean;
  register?: boolean;
};

export type RunningRouter = {
  gateway: Gateway;
  url: string;
  close(): Promise<void>;
};

function gatewayEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (env[CLIPROXY_API_KEY_ENV] === undefined) {
    const managed = cliproxyApiKey();
    if (managed !== undefined) env[CLIPROXY_API_KEY_ENV] = managed;
  }
  return env;
}

function accountConfigs(config: RouterConfig): SubscriptionAccountConfigs {
  const configured = config.accounts;
  const accounts: SubscriptionAccountConfigs = {};
  const claude = configured?.claudeCode;
  if (claude?.enabled === true) {
    accounts["claude-code"] = {
      source: { kind: "auto" },
      strategy: claude.strategy,
      switchThreshold: claude.switchThreshold,
      ...(claude.probeIntervalMs !== undefined
        ? { probeIntervalMs: claude.probeIntervalMs }
        : {})
    };
  }
  const codex = configured?.codex;
  if (codex?.enabled === true) {
    accounts.codex = {
      source: { kind: "auto" },
      strategy: codex.strategy,
      switchThreshold: codex.switchThreshold,
      ...(codex.probeIntervalMs !== undefined
        ? { probeIntervalMs: codex.probeIntervalMs }
        : {})
    };
  }
  return accounts;
}

export async function startRouter(options: RouterServeOptions): Promise<RunningRouter> {
  const backend = new CatalogBackend({
    config: options.config,
    env: gatewayEnvironment()
  });
  const accounts = accountConfigs(options.config);
  const { relays } =
    Object.keys(accounts).length > 0
      ? await openSubscriptionRelays({ accounts })
      : { relays: {} };
  const gateway = await startGateway({
    backend,
    ...(options.host !== undefined ? { host: options.host } : {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
    ...(Object.keys(relays).length > 0 ? { providerRelays: relays } : {})
  });

  let registration: ServiceRegistration | undefined;
  if (options.register !== false) {
    registration = await registerService({
      kind: "gateway",
      loopbackUrl: gateway.url(),
      port: gateway.port(),
      ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
      ...(options.portless !== undefined ? { portless: options.portless } : {})
    });
  }
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await registration?.release();
    await gateway.close();
  };
  registerCleanup(close);
  return { gateway, url: registration?.url ?? gateway.url(), close };
}

export async function waitForShutdown(): Promise<never> {
  return await new Promise<never>(() => undefined);
}
