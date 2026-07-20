import {
  CLIPROXY_API_KEY_ENV,
  cliproxyApiKey,
  collectSubscriptionUsage,
  openSubscriptionAccountSets,
  SubscriptionAccountBackend,
  subscriptionRelaysFromAccountSets
} from "@routekit/accounts";
import type { SubscriptionAccountConfigs } from "@routekit/accounts";
import {
  CatalogBackend,
  startGateway
} from "@routekit/gateway";
import type {
  Gateway,
  ProviderId,
  ProviderSource,
  RouterConfig
} from "@routekit/gateway";
import { assertAuthenticatedBind, registerCleanup } from "@routekit/runtime";

export type StartRouterOptions = {
  config: RouterConfig;
  host?: string;
  port?: number;
  authToken?: string;
  env?: NodeJS.ProcessEnv;
  sources?: Partial<Record<ProviderId, ProviderSource>>;
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
  const configured = config.providers;
  const accounts: SubscriptionAccountConfigs = {};
  const claude = configured["claude-code"];
  if (claude !== undefined) {
    accounts["claude-code"] = {
      source: { kind: "auto" },
      strategy: claude.strategy,
      switchThreshold: claude.switchThreshold,
      ...(claude.probeIntervalMs !== undefined
        ? { probeIntervalMs: claude.probeIntervalMs }
        : {}),
      ...(claude.fallbackCooldownSeconds !== undefined
        ? { fallbackCooldownSeconds: claude.fallbackCooldownSeconds }
        : {})
    };
  }
  const codex = configured.codex;
  if (codex !== undefined) {
    accounts.codex = {
      source: { kind: "auto" },
      strategy: codex.strategy,
      switchThreshold: codex.switchThreshold,
      ...(codex.probeIntervalMs !== undefined
        ? { probeIntervalMs: codex.probeIntervalMs }
        : {}),
      ...(codex.fallbackCooldownSeconds !== undefined
        ? { fallbackCooldownSeconds: codex.fallbackCooldownSeconds }
        : {})
    };
  }
  return accounts;
}

export async function startRouter(options: StartRouterOptions): Promise<RunningRouter> {
  const host = options.host ?? "127.0.0.1";
  assertAuthenticatedBind(host, options.authToken);
  const accounts = accountConfigs(options.config);
  const accountSets = await openSubscriptionAccountSets(accounts);
  const requiredKinds = new Set(
    (["claude-code", "codex"] as const).filter(
      (provider) =>
        options.config.providers[provider] !== undefined &&
        options.sources?.[provider] === undefined
    )
  );
  for (const kind of requiredKinds) {
    if ((accountSets[kind]?.size ?? 0) === 0) {
      await Promise.all(
        Object.values(accountSets).map(async (accountSet) => await accountSet.close())
      );
      throw new Error(
        `provider "${kind}" requires an enrolled account; ` +
          `run \`routekit accounts login ${kind} --name <label>\``
      );
    }
  }
  const relays = subscriptionRelaysFromAccountSets(accountSets);
  for (const [kind, accountSet] of Object.entries(accountSets)) {
    if (accountSet.size === 0 && !requiredKinds.has(kind as "claude-code" | "codex")) {
      await accountSet.close();
    }
  }
  const sources: Partial<Record<ProviderId, ProviderSource>> = {
    ...options.sources
  };
  for (const kind of requiredKinds) {
    sources[kind] = new SubscriptionAccountBackend({
      accountSet: accountSets[kind]!
    });
  }
  let backend: CatalogBackend;
  try {
    backend = await CatalogBackend.create({
      config: options.config,
      env: gatewayEnvironment(options.env ?? process.env),
      sources
    });
  } catch (error) {
    await Promise.all(
      Object.values(accountSets).map(async (accountSet) => await accountSet.close())
    );
    throw error;
  }
  let gateway: Gateway;
  try {
    gateway = await startGateway({
      backend,
      host,
      ...(options.port !== undefined ? { port: options.port } : {}),
      ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
      ...(Object.keys(relays).length > 0 ? { providerRelays: relays } : {}),
      usage: async () => await collectSubscriptionUsage(accountSets)
    });
  } catch (error) {
    await backend.close();
    await Promise.all(
      Object.values(accountSets).map(async (accountSet) => await accountSet.close())
    );
    throw error;
  }
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await gateway.close();
  };
  registerCleanup(close);
  return { gateway, url: gateway.url(), close };
}
