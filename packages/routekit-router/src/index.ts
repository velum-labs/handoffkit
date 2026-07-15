import {
  CLIPROXY_API_KEY_ENV,
  cliproxyApiKey,
  openSubscriptionRelays
} from "@routekit/accounts";
import type { SubscriptionAccountConfigs } from "@routekit/accounts";
import { CatalogBackend, startGateway } from "@routekit/gateway";
import type { Gateway, RouterConfig } from "@routekit/gateway";
import { registerCleanup } from "@routekit/runtime";

export type StartRouterOptions = {
  config: RouterConfig;
  host?: string;
  port?: number;
  authToken?: string;
  env?: NodeJS.ProcessEnv;
};

export type RunningRouter = {
  gateway: Gateway;
  url: string;
  close(): Promise<void>;
};

function gatewayEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const resolved = { ...env };
  if (resolved[CLIPROXY_API_KEY_ENV] === undefined) {
    const managed = cliproxyApiKey();
    if (managed !== undefined) resolved[CLIPROXY_API_KEY_ENV] = managed;
  }
  return resolved;
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

export async function startRouter(options: StartRouterOptions): Promise<RunningRouter> {
  const backend = new CatalogBackend({
    config: options.config,
    env: gatewayEnvironment(options.env ?? process.env)
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
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await gateway.close();
  };
  registerCleanup(close);
  return { gateway, url: gateway.url(), close };
}
