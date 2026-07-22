/**
 * Singleton RouteKit daemon.
 *
 * One process owns a private authenticated control listener and one stable
 * model-gateway front door. Router generations run on ephemeral loopback
 * ports behind that front door; config/account reload builds a complete new
 * generation before atomically switching new traffic and draining the old.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync
} from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  CLIPROXY_API_KEY_ENV,
  CLIPROXY_BASE_URL_ENV,
  accountStoreEntries,
  cliproxyAuthDirectory,
  cliproxyAccountEntries,
  cliproxyAccountMatchesKind,
  cliproxyApiKey,
  cliproxyBaseUrl,
  cliproxyCredentialValid,
  defaultSubscriptionAccountDirectory,
  removeCliproxyAccount,
  removeSubscriptionAccount,
  sanitizeSubscriptionLabel
} from "@routekit/accounts";
import type { AccountStoreEntry, SubscriptionCredential } from "@routekit/accounts";
import {
  configuredProviderIds,
  globalRouterConfigPath,
  parseRouterConfigDocument,
  routekitHome,
  writeRouterConfig
} from "@routekit/config";
import {
  createRouteKitControlHandler,
  ROUTEKIT_CONTROL_CAPABILITY
} from "@routekit/control";
import type {
  ConfigSnapshot,
  DaemonStatus,
  ModelInfo,
  RouteKitControlHandlers
} from "@routekit/control";
import {
  startSwitchingGatewayProxy
} from "@routekit/gateway";
import type {
  RouterConfig,
  SwitchingGatewayProxy
} from "@routekit/gateway";
import {
  PROVIDERS,
  accountKindForCliproxyAuthType,
  resolveAccountConnector
} from "@routekit/registry";
import type { SubscriptionMode } from "@routekit/registry";
import { startRouter } from "@routekit/router";
import type { RunningRouter } from "@routekit/router";
import {
  acquireLifecycleLock,
  CONTROL_PROTOCOL_VERSION,
  ControlClient,
  ControlError,
  createPortlessSession,
  createServiceRecordStore,
  extendCleanupGrace,
  generateControlToken,
  nextServiceGeneration,
  processIdentity,
  registerCleanup,
  startControlServer,
  supervisorFromEnv,
  writeFileAtomic
} from "@routekit/runtime";
import type {
  PortlessSession,
  RunningControlServer,
  ServiceRecord
} from "@routekit/runtime";
import { createConsentManager } from "@routekit/telemetry-core";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { createCliproxySidecar } from "./cliproxy-sidecar.js";
import {
  cleanupAccountTransaction,
  markAccountTransactionCommitted,
  prepareAccountTransaction,
  recoverAccountTransactions,
  rollbackAccountTransaction
} from "./account-transaction.js";

export const ROUTEKIT_DAEMON_KIND = "daemon";
export const ROUTEKIT_PRODUCT = "routekit";

export type RouteKitDaemonOptions = {
  packageVersion: string;
  env?: NodeJS.ProcessEnv;
  stateHome?: string;
  configPath?: string;
  host?: string;
  port?: number;
  authToken?: string;
  authTokenFile?: string;
  portless?: boolean;
  drainGraceMs?: number;
  onShutdownRequested?: (reason: "stop" | "restart" | "upgrade") => void;
  /** Test seam used by child-process interruption coverage. */
  onAccountTransactionPhase?: (
    phase: "prepared" | "credentials-written" | "router-swapped" | "committed"
  ) => void;
};

export type RunningRouteKitDaemon = {
  record: ServiceRecord;
  dataUrl: string;
  controlUrl: string;
  close(): Promise<void>;
  reload(): Promise<void>;
};

function dataTokenPath(home: string): string {
  return join(home, "secrets", "data-token");
}

function redactedProcessArgs(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === "--auth-token") {
      index += 1;
      result.push("--auth-token", "[REDACTED]");
    } else if (value.startsWith("--auth-token=")) {
      result.push("--auth-token=[REDACTED]");
    } else {
      result.push(value);
    }
  }
  return result;
}

function resolveDataToken(
  home: string,
  input: { authToken?: string; authTokenFile?: string }
): { token: string; path: string } {
  const path = input.authTokenFile ?? dataTokenPath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token =
    input.authToken ??
    (existsSync(path) ? readFileSync(path, "utf8").trim() : generateControlToken());
  if (token.length === 0) throw new Error("RouteKit data-plane token is empty");
  writeFileAtomic(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { token, path };
}

type RevisionState = { config: number; accounts: number; daemon: number };

function revisionPath(home: string): string {
  return join(home, "daemon-revisions.json");
}

function readRevisions(home: string): RevisionState {
  try {
    const parsed = JSON.parse(readFileSync(revisionPath(home), "utf8")) as Partial<RevisionState>;
    return {
      config:
        typeof parsed.config === "number" && Number.isSafeInteger(parsed.config)
          ? parsed.config
          : 0,
      accounts:
        typeof parsed.accounts === "number" && Number.isSafeInteger(parsed.accounts)
          ? parsed.accounts
          : 0,
      daemon:
        typeof parsed.daemon === "number" && Number.isSafeInteger(parsed.daemon)
          ? parsed.daemon
          : 0
    };
  } catch {
    return { config: 0, accounts: 0, daemon: 0 };
  }
}
function writeRevisions(home: string, revisions: RevisionState): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileAtomic(revisionPath(home), `${JSON.stringify(revisions, null, 2)}\n`, {
    mode: 0o600
  });
  chmodSync(revisionPath(home), 0o600);
}

function writeSnapshot(home: string, category: "catalog" | "health", name: string, value: unknown): void {
  const directory = join(home, category);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${name}.json`);
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function canonicalConfigDocument(path: string): string {
  if (!existsSync(path)) {
    throw new ControlError({
      code: "unavailable",
      message:
        `canonical router config not found: ${path}; run ` +
        "`routekit config init --global` or `routekit config import --from <path>`"
    });
  }
  return readFileSync(path, "utf8");
}

function parseConfigDocument(document: string): RouterConfig {
  try {
    return parseRouterConfigDocument(document, "daemon config update");
  } catch (error) {
    throw new ControlError({
      code: "bad_request",
      message: error instanceof Error ? error.message : String(error)
    });
  }
}
function revisionConflict(expected: number, actual: number): never {
  throw new ControlError({
    code: "conflict",
    message: `revision conflict: expected ${expected}, current ${actual}`,
    details: { expected, actual }
  });
}

type WithoutPath<T> = T extends { path: string } ? Omit<T, "path"> : never;
type AccountEntry = WithoutPath<AccountStoreEntry>;

function accountEntries(env: NodeJS.ProcessEnv): AccountEntry[] {
  return accountStoreEntries(env).map(({ path: _path, ...entry }) => entry);
}

function providerCredentialAvailable(
  provider: string,
  accounts: ReturnType<typeof accountEntries>,
  env: NodeJS.ProcessEnv
): boolean {
  if (provider === "claude-code" || provider === "codex") {
    return accounts.some((entry) => entry.subscriptionKind === provider);
  }
  if (provider === "cliproxy") {
    return (
      (env[CLIPROXY_API_KEY_ENV] ?? "").length > 0 || cliproxyApiKey(env) !== undefined
    );
  }
  const info = PROVIDERS[provider];
  if (info?.keyEnv === undefined) return true;
  return (env[info.keyEnv] ?? "").length > 0;
}

function safeCredentialBlob(
  kind: "claude-code" | "codex",
  value: unknown
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ControlError({ code: "bad_request", message: "credential must be an object" });
  }
  const record = structuredClone(value as Record<string, unknown>);
  const valid =
    kind === "claude-code"
      ? typeof (record.claudeAiOauth as Record<string, unknown> | undefined)?.accessToken ===
        "string"
      : typeof (record.tokens as Record<string, unknown> | undefined)?.access_token === "string" ||
        typeof record.access_token === "string";
  if (!valid) {
    throw new ControlError({
      code: "bad_request",
      message: `credential does not have the expected ${kind} token shape`
    });
  }
  return record;
}

function safeCliproxyCredentialBlob(
  kind: string,
  value: unknown
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ControlError({ code: "bad_request", message: "credential must be an object" });
  }
  const record = structuredClone(value as Record<string, unknown>);
  const type = typeof record.type === "string" ? record.type : undefined;
  const classified =
    type === undefined
      ? undefined
      : accountKindForCliproxyAuthType(type) ?? resolveAccountConnector(type)?.kind;
  if (classified !== kind || !cliproxyCredentialValid(record, type)) {
    throw new ControlError({
      code: "bad_request",
      message: `credential does not have the expected ${kind} connector shape`
    });
  }
  return record;
}

function safeCliproxyLabel(label: string): string {
  if (
    label.length === 0 ||
    label.startsWith(".") ||
    basename(label) !== label ||
    label.includes("\\")
  ) {
    throw new ControlError({
      code: "bad_request",
      message: "connector account label is not path-safe"
    });
  }
  return label;
}

async function healthyControl(record: ServiceRecord): Promise<boolean> {
  if (record.controlToken === undefined) return false;
  try {
    const client = new ControlClient({
      url: record.url,
      token: record.controlToken,
      timeoutMs: 1_000
    });
    const health = await client.health();
    return health.protocol === CONTROL_PROTOCOL_VERSION;
  } catch {
    return false;
  }
}

export async function startRouteKitDaemon(
  options: RouteKitDaemonOptions
): Promise<RunningRouteKitDaemon> {
  const env = options.env ?? process.env;
  const home = options.stateHome ?? routekitHome(env);
  const configPath = options.configPath ?? globalRouterConfigPath();
  const drainGraceMs = options.drainGraceMs ?? 30_000;
  const dataAuth = resolveDataToken(home, options);
  const store = createServiceRecordStore({ home, product: ROUTEKIT_PRODUCT });
  // Held for the daemon's whole lifetime. Lifecycle clients use daemon.lock
  // while this authority lock prevents any second daemon from becoming live.
  const authority = await acquireLifecycleLock(join(store.directory, "daemon-authority.lock"), {
    timeoutMs: 30_000,
    onWait: async () => {
      const existing = store.read(ROUTEKIT_DAEMON_KIND);
      return existing !== undefined && (await healthyControl(existing))
        ? new ControlError({
            code: "conflict",
            message: `RouteKit daemon is already running (pid ${existing.pid})`
          })
        : undefined;
    }
  });
  const accountRecovery = recoverAccountTransactions(home, configPath);

  let control: RunningControlServer | undefined;
  let proxy: SwitchingGatewayProxy | undefined;
  let portless: PortlessSession | undefined;
  let sidecarRef: ReturnType<typeof createCliproxySidecar> | undefined;
  let activeRouter: RunningRouter | undefined;
  let record: ServiceRecord | undefined;
  let closed = false;
  let draining = false;
  let lifecycle: "running" | "quiescing" | "draining" | "closed" = "running";
  let revisions = readRevisions(home);
  let currentDocument = canonicalConfigDocument(configPath);
  let currentConfig = parseConfigDocument(currentDocument);
  let mutationTail: Promise<void> = Promise.resolve();
  const serializeMutation = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (lifecycle !== "running") {
      throw new ControlError({
        code: "unavailable",
        message: "RouteKit daemon is shutting down"
      });
    }
    const result = mutationTail.then(operation);
    mutationTail = result.then(
      () => undefined,
      () => undefined
    );
    return await result;
  };
  const startedAt = new Date().toISOString();

  try {
    const previous = store.read(ROUTEKIT_DAEMON_KIND);
    if (
      previous !== undefined &&
      previous.pid !== process.pid &&
      (await healthyControl(previous))
    ) {
      throw new ControlError({
        code: "conflict",
        message: `RouteKit daemon is already running (pid ${previous.pid})`
      });
    }
    if (previous !== undefined && previous.pid !== process.pid) {
      // A live-but-unhealthy daemon is not safe to replace under its feet.
      throw new ControlError({
        code: "unavailable",
        message: `RouteKit daemon pid ${previous.pid} is alive but its control plane is unhealthy; stop it before recovery`
      });
    }
    const generation = nextServiceGeneration(
      Math.max(previous?.generation ?? 0, revisions.daemon)
    );
    revisions.daemon = generation;
    writeRevisions(home, revisions);
    const sidecar = createCliproxySidecar({ env });
    sidecarRef = sidecar;
    const wantsCliproxySidecar = (config: RouterConfig): boolean =>
      config.providers["cliproxy"] !== undefined;
    // Router generations reach the managed sidecar with its own ingress key
    // and configured listen address; resolved per generation so state created
    // by the first login (key, config) is seen without a daemon restart.
    const routerEnv = (): NodeJS.ProcessEnv => {
      const injected: NodeJS.ProcessEnv = { ...env };
      if ((env[CLIPROXY_API_KEY_ENV] ?? "").length === 0) {
        const key = cliproxyApiKey(env);
        if (key !== undefined) injected[CLIPROXY_API_KEY_ENV] = key;
      }
      if ((env[CLIPROXY_BASE_URL_ENV] ?? "").length === 0) {
        injected[CLIPROXY_BASE_URL_ENV] = cliproxyBaseUrl(env);
      }
      return injected;
    };
    const startGeneration = async (config: RouterConfig): Promise<RunningRouter> =>
      await startRouter({
        config,
        host: "127.0.0.1",
        port: 0,
        env: routerEnv(),
        drainGraceMs
      });
    await sidecar.reconcile(wantsCliproxySidecar(currentConfig));
    activeRouter = await startGeneration(currentConfig);
    proxy = await startSwitchingGatewayProxy({
      target: activeRouter.url,
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 8080,
      authToken: dataAuth.token
    });
    portless = await createPortlessSession(
      options.portless ?? env.ROUTEKIT_PORTLESS !== "0",
      { project: "routekit", ownerLabel: "routekit-daemon", bareNames: [] }
    );
    const dataUrl = portless.enabled
      ? portless.register("gateway", proxy.port())
      : proxy.url();

    const replaceRouter = async (
      nextConfig: RouterConfig,
      nextDocument: string,
      input: { write: boolean; configRevision?: boolean; accountRevision?: boolean }
    ): Promise<void> => {
      // Sidecar reconcile runs before the generation commits; any failure
      // below must put the sidecar back to the still-live currentConfig.
      let candidate: RunningRouter;
      try {
        await sidecar.reconcile(wantsCliproxySidecar(nextConfig));
        candidate = await startGeneration(nextConfig);
      } catch (error) {
        try {
          await sidecar.reconcile(wantsCliproxySidecar(currentConfig));
        } catch {
          // Best-effort rollback; surface the original mutation failure.
        }
        throw error;
      }
      const previousDocument = currentDocument;
      const previousRevisions = { ...revisions };
      const nextRevisions = { ...revisions };
      if (input.configRevision === true) nextRevisions.config += 1;
      if (input.accountRevision === true) nextRevisions.accounts += 1;
      try {
        if (input.write) writeRouterConfig(configPath, nextConfig);
        writeRevisions(home, nextRevisions);
      } catch (error) {
        if (input.write) {
          writeFileAtomic(configPath, previousDocument, { mode: 0o600 });
          chmodSync(configPath, 0o600);
        }
        revisions = previousRevisions;
        writeRevisions(home, previousRevisions);
        await candidate.close();
        await sidecar.reconcile(wantsCliproxySidecar(currentConfig));
        throw error;
      }
      const previousRouter = activeRouter;
      // From this point the mutation is committed. `swapTarget` is synchronous
      // and non-throwing; retirement failures must never close the candidate.
      const previousTarget = proxy?.swapTarget(candidate.url);
      activeRouter = candidate;
      currentConfig = nextConfig;
      currentDocument = input.write ? readFileSync(configPath, "utf8") : nextDocument;
      revisions = nextRevisions;
      if (previousRouter !== undefined) {
        try {
          if (previousTarget !== undefined) {
            await proxy?.waitForTargetIdle(previousTarget, drainGraceMs);
          }
          await previousRouter.gateway.drain(drainGraceMs);
          await previousRouter.close();
        } catch (error) {
          process.stderr.write(
            `routekit retired router cleanup failed: ${
              error instanceof Error ? error.message : String(error)
            }\n`
          );
        }
      }
    };

    const configSnapshot = (): ConfigSnapshot => ({
      path: configPath,
      document: currentDocument,
      revision: revisions.config,
      sources: ["global"]
    });

    let handlers: RouteKitControlHandlers;
    const telemetry = createConsentManager({
      path: () => join(home, "telemetry.json"),
      environmentVariable: "ROUTEKIT_TELEMETRY"
    });
    handlers = {
      "daemon.status": async () =>
        ({
          pid: process.pid,
          startedAt,
          packageVersion: options.packageVersion,
          protocolVersion: CONTROL_PROTOCOL_VERSION,
          generation,
          configRevision: revisions.config,
          accountRevision: revisions.accounts,
          controlUrl: control?.url ?? "",
          dataUrl,
          dataPort: proxy?.port() ?? 0,
          supervisor: supervisorFromEnv(env),
          draining
        }) satisfies DaemonStatus,
      "daemon.reload": async (params) => {
        await serializeMutation(async () => {
          if (
            params.expectedRevision !== undefined &&
            params.expectedRevision !== revisions.config
          ) {
            revisionConflict(params.expectedRevision, revisions.config);
          }
          const document = canonicalConfigDocument(configPath);
          await replaceRouter(parseConfigDocument(document), document, {
            write: false,
            configRevision: true
          });
        });
        return {
          reloaded: true,
          configRevision: revisions.config,
          accountRevision: revisions.accounts
        };
      },
      "daemon.prepareShutdown": async (params) => {
        if (lifecycle !== "running") return { accepted: true };
        lifecycle = "quiescing";
        draining = true;
        await mutationTail;
        queueMicrotask(() => options.onShutdownRequested?.(params.reason));
        return { accepted: true };
      },
      "config.get": async () => configSnapshot(),
      "config.update": async (params) => {
        await serializeMutation(async () => {
          if (params.expectedRevision !== revisions.config) {
            revisionConflict(params.expectedRevision, revisions.config);
          }
          const next = parseConfigDocument(params.document);
          await replaceRouter(next, params.document, {
            write: true,
            configRevision: true
          });
        });
        return configSnapshot();
      },
      "config.import": async (params) => {
        await serializeMutation(async () => {
          if (params.expectedRevision !== revisions.config) {
            revisionConflict(params.expectedRevision, revisions.config);
          }
          const next = parseConfigDocument(params.document);
          await replaceRouter(next, params.document, {
            write: true,
            configRevision: true
          });
        });
        return configSnapshot();
      },
      "providers.status": async (_params, context) => {
        const accounts = accountEntries(env);
        const live = await activeRouter!.providerStatuses(context.signal);
        const result = {
          providers: configuredProviderIds(currentConfig).map((provider) => {
            const status = live.find((entry) => entry.provider === provider);
            return {
              provider,
              configured: true,
              credentialAvailable: providerCredentialAvailable(provider, accounts, env),
              models: status?.models ?? [],
              ...(status?.error !== undefined ? { error: status.error } : {})
            };
          })
        };
        writeSnapshot(home, "health", "providers", {
          checkedAt: new Date().toISOString(),
          providers: result.providers
        });
        return result;
      },
      "providers.set": async (params) => {
        await serializeMutation(async () => {
          const raw = parseYaml(currentDocument) as Record<string, unknown>;
          const providers =
            typeof raw.providers === "object" &&
            raw.providers !== null &&
            !Array.isArray(raw.providers)
              ? { ...(raw.providers as Record<string, unknown>) }
              : {};
          if (params.enabled) providers[params.provider] ??= {};
          else delete providers[params.provider];
          raw.providers = providers;
          const document = stringifyYaml(raw);
          await replaceRouter(parseConfigDocument(document), document, {
            write: true,
            configRevision: true
          });
        });
        return configSnapshot();
      },
      "models.list": async (params) => {
        const response = await fetch(`${dataUrl}/v1/models`, {
          headers: { authorization: `Bearer ${dataAuth.token}` }
        });
        if (!response.ok) {
          throw new ControlError({
            code: "unavailable",
            message: `gateway model discovery failed (${response.status})`
          });
        }
        const body = (await response.json()) as { data?: ModelInfo[] };
        const models = (body.data ?? []).filter(
          (model) => params.provider === undefined || model.id.startsWith(`${params.provider}/`)
        );
        const result = {
          models,
          ...(currentConfig.defaultModel !== undefined
            ? { defaultModel: currentConfig.defaultModel }
            : {}),
          revision: revisions.config
        };
        writeSnapshot(home, "catalog", "models", {
          updatedAt: new Date().toISOString(),
          defaultModel: result.defaultModel,
          models
        });
        return result;
      },
      "models.info": async (params) => {
        const listed = await handlers["models.list"]({}, {
          signal: new AbortController().signal,
          requestId: "internal"
        });
        const model = listed.models.find((entry) => entry.id === params.model);
        if (model === undefined) {
          throw new ControlError({
            code: "not_found",
            message: `unknown model: ${params.model}`
          });
        }
        return model;
      },
      "accounts.list": async () => ({
        accounts: accountEntries(env).map((entry) => {
          if (entry.connector === "native") return entry;
          const { credentialValid: _credentialValid, ...listed } = entry;
          return listed;
        }),
        revision: revisions.accounts
      }),
      "accounts.status": async () => {
        const entries = accountEntries(env);
        const cliproxyConfigured = currentConfig.providers["cliproxy"] !== undefined;
        const cliproxyReachable =
          entries.some((entry) => entry.connector === "cliproxy") && cliproxyConfigured
            ? await sidecar.reachable()
            : false;
        return {
          accounts: entries.map((entry) => {
            if (entry.connector === "cliproxy") {
              return {
                subscriptionKind: entry.subscriptionKind,
                label: entry.label,
                connector: entry.connector,
                ...(entry.localOnly === true ? { localOnly: true } : {}),
                credentialValid: entry.credentialValid,
                configured: cliproxyConfigured,
                relayOpen:
                  entry.credentialValid && cliproxyConfigured && cliproxyReachable,
                active:
                  entry.credentialValid && cliproxyConfigured && cliproxyReachable,
                models: []
              };
            }
            const member = activeRouter!
              .accountSnapshots()
              .find((snapshot) => snapshot.mode === entry.subscriptionKind)
              ?.members.find((candidate) => candidate.label === entry.label);
            return {
              subscriptionKind: entry.subscriptionKind,
              label: entry.label,
              connector: entry.connector,
              credentialValid: member?.credentialValid ?? false,
              configured: currentConfig.providers[entry.subscriptionKind] !== undefined,
              relayOpen:
                member?.relayReady === true &&
                currentConfig.providers[entry.subscriptionKind] !== undefined,
              active: member?.active ?? false,
              models: member?.models ?? [],
              ...(member?.limits !== undefined ? { limits: member.limits } : {})
            };
          }),
          revision: revisions.accounts,
          recovery: {
            state: accountRecovery.recovered > 0 ? "recovered" : "clean",
            recovered: accountRecovery.recovered,
            cleaned: accountRecovery.cleaned
          }
        };
      },
      "accounts.enroll": async (params) => {
        await serializeMutation(async () => {
          const label = sanitizeSubscriptionLabel(params.label);
          if (label !== params.label || label.startsWith(".")) {
            throw new ControlError({
              code: "bad_request",
              message: "account label must already be normalized"
            });
          }
          const directory = defaultSubscriptionAccountDirectory(params.kind, env);
          mkdirSync(directory, { recursive: true, mode: 0o700 });
          const path = join(directory, `${label}.json`);
          if (existsSync(path)) {
            throw new ControlError({
              code: "conflict",
              message: `${params.kind}/${label} is already enrolled; remove it before enrolling again`
            });
          }
          const previous = existsSync(path) ? readFileSync(path) : undefined;
          writeFileAtomic(
            path,
            `${JSON.stringify(safeCredentialBlob(params.kind, params.credential), null, 2)}\n`,
            { mode: 0o600 }
          );
          chmodSync(path, 0o600);
          try {
            await replaceRouter(currentConfig, currentDocument, {
              write: false,
              accountRevision: true
            });
          } catch (error) {
            if (previous === undefined) rmSync(path, { force: true });
            else {
              writeFileAtomic(path, previous.toString("utf8"), { mode: 0o600 });
              chmodSync(path, 0o600);
            }
            throw error;
          }
        });
        return { enrolled: true, revision: revisions.accounts };
      },
      "accounts.enrollActivate": async (params) => {
        const resolved = resolveAccountConnector(params.kind);
        if (resolved === undefined) {
          throw new ControlError({
            code: "bad_request",
            message: `unknown subscription kind: ${params.kind}`
          });
        }
        const kind = resolved.kind;
        const connector = resolved.info.connector;
        const provider = connector === "cliproxy" ? "cliproxy" : kind;
        const seenLabels = new Set<string>();
        const prepared = params.accounts.map((account) => {
          const label =
            connector === "native"
              ? sanitizeSubscriptionLabel(account.label)
              : safeCliproxyLabel(account.label);
          if (
            label !== account.label ||
            (connector === "native" && label.startsWith("."))
          ) {
            throw new ControlError({
              code: "bad_request",
              message: "account label must already be normalized"
            });
          }
          if (seenLabels.has(label)) {
            throw new ControlError({
              code: "bad_request",
              message: `duplicate account label: ${label}`
            });
          }
          seenLabels.add(label);
          const directory =
            connector === "native"
              ? defaultSubscriptionAccountDirectory(kind as SubscriptionMode, env)
              : cliproxyAuthDirectory(env);
          const path = join(directory, `${label}.json`);
          let credential = account.credential;
          if (credential === undefined) {
            if (!existsSync(path)) {
              throw new ControlError({
                code: "not_found",
                message: `${kind}/${label} is not enrolled`
              });
            }
            try {
              credential = JSON.parse(readFileSync(path, "utf8")) as unknown;
            } catch {
              throw new ControlError({
                code: "bad_request",
                message: `${kind}/${label} has an invalid stored credential`
              });
            }
          }
          const blob =
            connector === "native"
              ? safeCredentialBlob(kind as SubscriptionMode, credential)
              : safeCliproxyCredentialBlob(kind, credential);
          const content = `${JSON.stringify(blob, null, 2)}\n`;
          if (
            connector === "native" &&
            account.credential !== undefined &&
            existsSync(path) &&
            readFileSync(path, "utf8") !== content
          ) {
            throw new ControlError({
              code: "conflict",
              message: `${kind}/${label} is already enrolled with different credentials`
            });
          }
          return { label, directory, path, content };
        });
        await serializeMutation(async () => {
          const unchanged = prepared.every(
            (entry) =>
              existsSync(entry.path) &&
              readFileSync(entry.path, "utf8") === entry.content
          );
          if (
            unchanged &&
            (currentConfig.providers as Record<string, unknown>)[provider] !== undefined
          ) {
            return;
          }

          const raw = parseYaml(currentDocument) as Record<string, unknown>;
          const providers =
            typeof raw.providers === "object" &&
            raw.providers !== null &&
            !Array.isArray(raw.providers)
              ? { ...(raw.providers as Record<string, unknown>) }
              : {};
          providers[provider] ??= {};
          raw.providers = providers;
          const nextDocument = stringifyYaml(raw);
          const nextConfig = parseConfigDocument(nextDocument);
          const previousDocument = currentDocument;
          const previousConfig = currentConfig;
          const transaction = prepareAccountTransaction({
            home,
            configPath,
            accountPaths: prepared.map((entry) => entry.path),
            kind,
            provider,
            labels: prepared.map((entry) => entry.label)
          });
          options.onAccountTransactionPhase?.("prepared");
          let routerReplaced = false;
          try {
            for (const entry of prepared) {
              mkdirSync(entry.directory, { recursive: true, mode: 0o700 });
              chmodSync(entry.directory, 0o700);
              writeFileAtomic(entry.path, entry.content, { mode: 0o600 });
              chmodSync(entry.path, 0o600);
            }
            options.onAccountTransactionPhase?.("credentials-written");
            if (connector === "cliproxy") await sidecar.refresh();
            await replaceRouter(nextConfig, nextDocument, {
              write: true,
              configRevision: true,
              accountRevision: true
            });
            routerReplaced = true;
            options.onAccountTransactionPhase?.("router-swapped");
            markAccountTransactionCommitted(transaction);
            options.onAccountTransactionPhase?.("committed");
            try {
              cleanupAccountTransaction(transaction);
            } catch {
              // A committed manifest is cleanup-only on the next daemon start.
            }
          } catch (error) {
            const rollbackFailures: unknown[] = [];
            try {
              rollbackAccountTransaction(transaction, home, configPath);
            } catch (rollbackError) {
              rollbackFailures.push(rollbackError);
            }
            if (connector === "cliproxy") {
              try {
                await sidecar.refresh();
              } catch (rollbackError) {
                rollbackFailures.push(rollbackError);
              }
            }
            if (routerReplaced) {
              try {
                await replaceRouter(previousConfig, previousDocument, {
                  write: false
                });
              } catch (rollbackError) {
                rollbackFailures.push(rollbackError);
              }
            }
            if (rollbackFailures.length > 0) {
              throw new AggregateError(
                [error, ...rollbackFailures],
                `could not activate ${kind}; rollback failed`
              );
            }
            throw error;
          }
        });
        return {
          enrolled: prepared.map((entry) => ({
            subscriptionKind: kind,
            label: entry.label
          })),
          activated: true,
          configPath,
          configRevision: revisions.config,
          accountRevision: revisions.accounts
        };
      },
      "accounts.remove": async (params) => {
        const resolved = resolveAccountConnector(params.kind);
        const rawCliproxyEntry =
          resolved === undefined
            ? cliproxyAccountEntries(env).find(
                (entry) =>
                  entry.kind === params.kind && entry.label === params.label
              )
            : undefined;
        if (resolved === undefined && rawCliproxyEntry === undefined) {
          throw new ControlError({
            code: "bad_request",
            message: `unknown subscription kind: ${params.kind}`
          });
        }
        const kind = resolved?.kind ?? params.kind;
        let removed = false;
        await serializeMutation(async () => {
          // Prefer the native account store when both connectors have a file
          // for the same label (claude-code/codex). Fall back to the cliproxy
          // store so legacy orphan auth files (type: claude|codex) and the
          // gemini/grok/kimi kinds remain removable through one surface.
          const nativeDirectory =
            resolved?.info.connector === "native"
              ? defaultSubscriptionAccountDirectory(kind as SubscriptionMode, env)
              : undefined;
          const nativePath =
            nativeDirectory !== undefined
              ? join(nativeDirectory, `${params.label}.json`)
              : undefined;
          if (nativePath !== undefined && existsSync(nativePath)) {
            const previous = readFileSync(nativePath);
            const result = removeSubscriptionAccount(
              kind as SubscriptionMode,
              params.label,
              { accountsDirectory: nativeDirectory }
            );
            removed = result.removed;
            if (!result.removed) return;
            try {
              await replaceRouter(currentConfig, currentDocument, {
                write: false,
                accountRevision: true
              });
            } catch (error) {
              writeFileAtomic(nativePath, previous.toString("utf8"), { mode: 0o600 });
              chmodSync(nativePath, 0o600);
              throw error;
            }
            return;
          }
          const entry = cliproxyAccountEntries(env).find(
            (candidate) =>
              candidate.label === params.label &&
              (resolved === undefined
                ? candidate.kind === kind
                : cliproxyAccountMatchesKind(candidate, kind))
          );
          if (entry === undefined) return;
          const previous = readFileSync(entry.path);
          const result = removeCliproxyAccount(params.label, env);
          removed = result.removed;
          if (!result.removed) return;
          try {
            await sidecar.refresh();
            await replaceRouter(currentConfig, currentDocument, {
              write: false,
              accountRevision: true
            });
          } catch (error) {
            writeFileAtomic(entry.path, previous.toString("utf8"), { mode: 0o600 });
            chmodSync(entry.path, 0o600);
            try {
              await sidecar.refresh();
            } catch {
              // Best-effort process rollback; preserve the mutation failure.
            }
            throw error;
          }
        });
        return { removed, revision: revisions.accounts };
      },
      "accounts.sync": async () => {
        // A connector login wrote new account state outside the control
        // channel (the cliproxy auth store); rebuild the router generation and
        // reconcile the managed sidecar against the rescanned stores.
        await serializeMutation(async () => {
          await sidecar.refresh();
          await replaceRouter(currentConfig, currentDocument, {
            write: false,
            accountRevision: true
          });
        });
        return { synced: true, revision: revisions.accounts };
      },
      "accounts.usage": async (_params, context) => {
        return await activeRouter!.usage(context.signal);
      },
      "telemetry.get": async () => ({ enabled: telemetry.resolve().enabled }),
      "telemetry.set": async (params) => {
        await serializeMutation(async () => {
          if (params.enabled) telemetry.enable();
          else telemetry.disable();
        });
        return { enabled: telemetry.resolve().enabled };
      },
      "doctor.run": async (_params, context) => {
        const providers = await activeRouter!.providerStatuses(context.signal);
        const accounts = accountEntries(env);
        const missingProviders = [
          ...new Set(
            accounts
              .filter((entry) => {
                const provider =
                  entry.connector === "cliproxy"
                    ? "cliproxy"
                    : entry.subscriptionKind;
                return currentConfig.providers[provider] === undefined;
              })
              .map((entry) => entry.subscriptionKind)
          )
        ];
        const providerOnly = ["claude-code", "codex", "cliproxy"].filter(
          (provider) =>
            (currentConfig.providers as Record<string, unknown>)[provider] !== undefined &&
            !accounts.some((entry) =>
              provider === "cliproxy"
                ? entry.connector === "cliproxy"
                : entry.subscriptionKind === provider
            )
        );
        const consistent = missingProviders.length === 0 && providerOnly.length === 0;
        return {
          checks: [
            { name: "canonical config", ok: existsSync(configPath), detail: configPath },
            { name: "control plane", ok: control !== undefined },
            { name: "model gateway", ok: proxy !== undefined, detail: dataUrl },
            {
              name: "account activation recovery",
              ok: true,
              detail:
                accountRecovery.recovered > 0
                  ? `recovered ${accountRecovery.recovered} interrupted operation(s)`
                  : "clean"
            },
            {
              name: "account/provider consistency",
              ok: consistent,
              detail: consistent
                ? "consistent"
                : [
                    ...(missingProviders.length > 0
                      ? [`routing disabled: ${missingProviders.join(", ")}`]
                      : []),
                    ...(providerOnly.length > 0
                      ? [`credential missing: ${providerOnly.join(", ")}`]
                      : [])
                  ].join("; ")
            },
            ...(wantsCliproxySidecar(currentConfig)
              ? [
                  {
                    name: "cliproxy sidecar",
                    ok: await sidecar.reachable(),
                    detail: sidecar.managed()
                      ? sidecar.running()
                        ? "managed; running"
                        : "managed; not running"
                      : "external"
                  }
                ]
              : []),
            ...providers.map((provider) => ({
              name: `${provider.provider} live discovery`,
              ok: provider.ok,
              detail: provider.error ?? `${provider.models.length} model(s)`
            }))
          ]
        };
      },
      "launcher.prepare": async (params) => {
        const listed = await handlers["models.list"]({}, {
          signal: new AbortController().signal,
          requestId: "internal"
        });
        const model = params.model ?? listed.defaultModel ?? listed.models[0]?.id;
        if (model === undefined || !listed.models.some((entry) => entry.id === model)) {
          throw new ControlError({
            code: "not_found",
            message: params.model === undefined ? "no model is available" : `unknown model: ${params.model}`
          });
        }
        return {
          tool: params.tool,
          model,
          gatewayUrl: dataUrl,
          authToken: dataAuth.token,
          env: {}
        };
      }
    };

    control = await startControlServer({
      handler: createRouteKitControlHandler(handlers),
      token: generateControlToken(),
      product: ROUTEKIT_PRODUCT,
      packageVersion: options.packageVersion,
      capabilities: [ROUTEKIT_CONTROL_CAPABILITY]
    });
    record = store.write({
      kind: ROUTEKIT_DAEMON_KIND,
      pid: process.pid,
      ...(processIdentity(process.pid) !== undefined
        ? { processIdentity: processIdentity(process.pid) }
        : {}),
      url: control.url,
      port: control.port,
      startedAt,
      version: options.packageVersion,
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      controlToken: control.token,
      dataUrl,
      dataPort: proxy.port(),
      host: options.host ?? "127.0.0.1",
      portless: portless.enabled,
      drainGraceMs,
      authTokenFile: dataAuth.path,
      generation,
      supervisor: supervisorFromEnv(env),
      ...(process.argv[1] !== undefined ? { binPath: process.argv[1] } : {}),
      args: redactedProcessArgs(process.argv.slice(2)),
      cwd: process.cwd()
    });
    extendCleanupGrace(drainGraceMs + 10_000);
    let closeRun: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closeRun ??= (async () => {
      closed = true;
      if (lifecycle === "running") lifecycle = "quiescing";
      draining = true;
      await mutationTail;
      lifecycle = "draining";
      await proxy?.drain(drainGraceMs);
      await activeRouter?.close();
      await sidecar.close();
      await control?.close();
      if (portless?.enabled) portless.unregister("gateway");
      store.remove(ROUTEKIT_DAEMON_KIND, { ifPid: process.pid });
      authority.release();
      lifecycle = "closed";
      })();
      return closeRun;
    };
    registerCleanup(close);
    process.on("SIGHUP", () => {
      void Promise.resolve(
        handlers["daemon.reload"]({}, {
          signal: new AbortController().signal,
          requestId: "sighup"
        })
      ).catch((error: unknown) => {
          process.stderr.write(
            `routekit daemon reload failed: ${error instanceof Error ? error.message : String(error)}\n`
          );
        });
    });
    return {
      record,
      dataUrl,
      controlUrl: control.url,
      close,
      reload: async () => {
        await handlers["daemon.reload"]({}, {
          signal: new AbortController().signal,
          requestId: "direct"
        });
      }
    };
  } catch (error) {
    await proxy?.close();
    await activeRouter?.close();
    await sidecarRef?.close();
    await control?.close();
    if (portless?.enabled) portless.unregister("gateway");
    if (record !== undefined) store.remove(ROUTEKIT_DAEMON_KIND, { ifPid: process.pid });
    authority.release();
    throw error;
  }
}
